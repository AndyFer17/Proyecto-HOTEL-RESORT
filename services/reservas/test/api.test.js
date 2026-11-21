import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { importPKCS8, SignJWT } from 'jose';
import { createVerifier } from '../../shared/security.js';
import { AppError } from '../../shared/errors.js';
import { createPool, withTransaction } from '../../shared/database.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';

const user = randomUUID();
const other = randomUUID();
const room = randomUUID();
const config = {
  SERVICE_TOKEN: 'reservas-service-test-token-of-at-least-32-characters',
  HABITACIONES_URL: 'http://habitaciones.test',
  PAGOS_URL: 'http://pagos.test',
  JWT_ISSUER: 'resort-clientes',
  JWT_AUDIENCE: 'resort-api',
};
let tokens, privateKey;
const logger = { info() {}, error() {} };

before(async () => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = await importPKCS8(pair.privateKey, 'RS256');
  tokens = await createVerifier({
    ...config,
    JWT_PUBLIC_KEY_BASE64: Buffer.from(pair.publicKey).toString('base64'),
  });
});
async function token(sub = user) {
  return new SignJWT({ rol: 'HUESPED' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime('15m')
    .sign(privateKey);
}
function date(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const input = () => ({
  habitacionId: room,
  desde: date(50),
  hasta: date(52),
  personas: 2,
});

function backend() {
  const state = {
    calls: [],
    holds: new Map(),
    charges: new Map(),
    notifications: new Map(),
    guards: new Map(),
    paid: false,
    fault: null,
    conflict: false,
    price: '1320.00',
  };
  state.call = async (base, path, options) => {
    const { method, body, key, token: auth } = options;
    assert.equal(auth, config.SERVICE_TOKEN);
    assert.match(key, /^[0-9a-f-]{36}$/);
    state.calls.push({ base, path, ...options });
    if (state.fault) await state.fault(base, path, options);
    if (base === config.HABITACIONES_URL) {
      if (method === 'POST') {
        if (state.conflict)
          throw new AppError(409, 'HABITACION_NO_DISPONIBLE', 'Ocupada.');
        if (!state.holds.has(key))
          state.holds.set(key, {
            bloqueoId: randomUUID(),
            total: state.price,
            moneda: 'PEN',
            ...body,
            estado: 'BLOQUEADO',
          });
        return { status: 201, body: state.holds.get(key) };
      }
      const id = path.split('/')[5];
      const hold = [...state.holds.values()].find((h) => h.bloqueoId === id);
      assert.ok(hold, `Hold exists for ${path}`);
      if (method === 'PUT') hold.estado = 'CONFIRMADO';
      if (method === 'DELETE') hold.estado = 'LIBERADO';
      if (method === 'PATCH') {
        if (state.conflict)
          throw new AppError(409, 'HABITACION_NO_DISPONIBLE', 'Ocupada.');
        Object.assign(hold, body, { total: state.price });
      }
      return {
        status: method === 'DELETE' ? 204 : 200,
        body: method === 'DELETE' ? null : hold,
      };
    }
    if (path.includes('/cuentas/')) {
      const reservaId = path.split('/')[5];
      if (method === 'PUT') {
        if (state.paid)
          throw new AppError(409, 'CUENTA_PAGADA', 'La cuenta ya fue pagada.');
        const previous = state.guards.get(reservaId);
        if (previous && previous !== body.operacionId)
          throw new AppError(409, 'CUENTA_BLOQUEADA', 'Otra operacion.');
        state.guards.set(reservaId, body.operacionId);
        return { status: 200, body: { estado: 'BLOQUEADA' } };
      }
      state.guards.delete(reservaId);
      return { status: 204, body: null };
    }
    if (path === '/api/v1/interno/cargos') {
      if (!state.charges.has(key))
        state.charges.set(key, {
          cargoId: randomUUID(),
          ...body,
          estado: 'ACTIVO',
        });
      return { status: 201, body: state.charges.get(key) };
    }
    if (path.includes('/cargos/')) {
      const id = path.split('/')[5];
      const charge = [...state.charges.values()].find((c) => c.cargoId === id);
      assert.ok(charge);
      assert.equal(
        state.guards.get(charge.reservaId),
        method === 'PATCH'
          ? body.operacionId
          : options.headers['X-Operacion-Id'],
      );
      if (method === 'PATCH') Object.assign(charge, { monto: body.monto });
      else charge.estado = 'ANULADO';
      return {
        status: method === 'PATCH' ? 200 : 204,
        body: method === 'PATCH' ? charge : null,
      };
    }
    if (path === '/api/v1/interno/notificaciones') {
      state.notifications.set(body.eventoId, body);
      return {
        status: 202,
        body: { notificacionId: randomUUID(), estado: 'PENDIENTE' },
      };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return state;
}

function concurrentLookups(db, key) {
  if (typeof db.connect !== 'function' || !key)
    return { connection: db, arrivals: () => 0 };
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release(), 5000).unref();
  return {
    arrivals: () => arrivals,
    connection: {
      query: db.query.bind(db),
      async connect() {
        const client = await db.connect();
        return {
          release: () => client.release(),
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (
              sql.startsWith(
                'SELECT * FROM reservas.operaciones WHERE huesped_id=',
              ) &&
              params?.[2] === key &&
              arrivals < 2
            ) {
              assert.equal(
                result.rows.length,
                0,
                'Both initial reads precede the first insert.',
              );
              arrivals += 1;
              if (arrivals === 2) {
                clearTimeout(timer);
                release();
              }
              await barrier;
            }
            return result;
          },
        };
      },
    },
  };
}

async function fixture(t, { postgres = false, barrierKey } = {}) {
  const db =
    postgres && process.env.TEST_RESERVAS_DATABASE_URL
      ? createPool(process.env.TEST_RESERVAS_DATABASE_URL)
      : new PGlite();
  await migrate(db);
  const concurrency = concurrentLookups(db, barrierKey);
  const remote = backend();
  const app = createApp({
    db: concurrency.connection,
    config,
    tokens,
    logger,
    call: remote.call,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await token();
  async function request(
    path,
    { method = 'GET', body, key, authorization = auth } = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  const create = (body = input(), key = randomUUID(), authorization) =>
    request('/api/v1/reservas', { method: 'POST', body, key, authorization });
  t.after(async () => {
    await app.locals.coordinator.stop();
    await new Promise((resolve) => server.close(resolve));
    if (typeof db.connect === 'function') {
      // Remove only this test file's random guest data, without truncating the
      // shared CI database or leaving fake outbox events for the integration suite.
      await withTransaction(db, async (tx) => {
        for (const table of ['outbox', 'operaciones'])
          await tx.query(
            `DELETE FROM reservas.${table} WHERE reserva_id IN
            (SELECT reserva_id FROM reservas.reservas WHERE huesped_id=$1)`,
            [user],
          );
        await tx.query('DELETE FROM reservas.reservas WHERE huesped_id=$1', [
          user,
        ]);
      });
    }
    await db.end?.();
    await db.close?.();
  });
  return { db, app, remote, request, create, concurrency };
}

test('migraciones repetibles, readiness y permisos de endpoints', async (t) => {
  const f = await fixture(t);
  assert.equal(await migrate(f.db), 0);
  assert.equal((await f.request('/health/ready')).status, 200);
  assert.equal((await f.create(input(), randomUUID(), '')).status, 401);
  assert.equal((await f.create({ ...input(), huespedId: other })).status, 400);
  assert.equal(
    (await f.request('/api/v1/reservas', { method: 'POST', body: input() }))
      .status,
    400,
  );
  const created = await f.create();
  assert.equal(created.status, 201);
  assert.equal(
    (
      await f.request(`/api/v1/reservas/${created.body.reservaId}`, {
        authorization: await token(other),
      })
    ).status,
    404,
  );
  const internal = `/api/v1/interno/reservas/${created.body.reservaId}/titular`;
  assert.equal((await f.request(internal)).status, 401);
  assert.deepEqual(
    (await f.request(internal, { authorization: config.SERVICE_TOKEN })).body,
    {
      reservaId: created.body.reservaId,
      huespedId: user,
      estado: 'CONFIRMADA',
    },
  );
});

test('crear confirma inventario y cargo sin cobrar; idempotencia scoped por huesped y cuerpo', async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const body = input();
  const created = await f.create(body, key);
  assert.equal(created.status, 201);
  assert.equal(created.body.huespedId, user);
  assert.equal(created.body.estado, 'CONFIRMADA');
  assert.equal(created.body.total, '1320.00');
  assert.equal(f.remote.charges.size, 1);
  const count = f.remote.calls.length;
  assert.deepEqual(await f.create(body, key), created);
  assert.equal(f.remote.calls.length, count);
  assert.equal((await f.create({ ...body, personas: 1 }, key)).status, 409);
  assert.equal((await f.create(body, key, await token(other))).status, 201);
  assert.equal(f.remote.charges.size, 2);
  assert.equal(
    f.remote.calls.some((c) => c.path === '/api/v1/pagos'),
    false,
  );
});

test('rechazo de inventario no genera cargo ni confirma reserva', async (t) => {
  const f = await fixture(t);
  f.remote.conflict = true;
  assert.equal((await f.create()).status, 409);
  assert.equal(f.remote.charges.size, 0);
  assert.equal(
    (await f.db.query('SELECT estado FROM reservas.reservas')).rows[0].estado,
    'FALLIDA',
  );
});

test('cargo rechazado compensa inventario; no retorna exito', async (t) => {
  const f = await fixture(t);
  f.remote.fault = async (base, path) => {
    if (path === '/api/v1/interno/cargos')
      throw new AppError(422, 'CARGO_RECHAZADO', 'Cargo invalido.');
  };
  const result = await f.create();
  assert.equal(result.status, 422);
  assert.equal([...f.remote.holds.values()][0].estado, 'LIBERADO');
  assert.equal(
    (await f.db.query('SELECT estado FROM reservas.reservas')).rows[0].estado,
    'FALLIDA',
  );
});

test('dependencia caida devuelve202; otro coordinador recupera fase durable sin duplicar', async (t) => {
  const f = await fixture(t);
  const body = input(),
    key = randomUUID();
  f.remote.fault = async (base, path) => {
    if (path === '/api/v1/interno/cargos')
      throw new AppError(503, 'DEPENDENCIA_NO_DISPONIBLE', 'Temporal.');
  };
  const pending = await f.create(body, key);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.estado, 'PENDIENTE');
  assert.equal(pending.body.fase, 'CREAR_CARGO');
  assert.equal(f.remote.holds.size, 1);
  f.remote.fault = null;
  const restarted = createApp({
    db: f.db,
    config,
    tokens,
    logger,
    call: f.remote.call,
  });
  await restarted.locals.coordinator.process(pending.body.operacionId);
  const ready = await f.create(body, key);
  assert.equal(ready.status, 201);
  assert.equal(ready.body.estado, 'CONFIRMADA');
  assert.equal(f.remote.holds.size, 1);
  assert.equal(f.remote.charges.size, 1);
});

test('outbox durable reintenta aviso sin revertir reserva confirmada', async (t) => {
  const f = await fixture(t);
  await f.create();
  f.remote.fault = async (base, path) => {
    if (path.includes('notificaciones'))
      throw new AppError(503, 'AVISO_NO_DISPONIBLE', 'Temporal.');
  };
  await f.app.locals.coordinator.dispatch();
  let row = (await f.db.query('SELECT * FROM reservas.outbox')).rows[0];
  assert.equal(row.enviado, false);
  assert.equal(
    (await f.db.query('SELECT estado FROM reservas.reservas')).rows[0].estado,
    'CONFIRMADA',
  );
  f.remote.fault = null;
  await f.db.query('UPDATE reservas.outbox SET proximo_intento=now()');
  await f.app.locals.coordinator.dispatch();
  row = (await f.db.query('SELECT * FROM reservas.outbox')).rows[0];
  assert.equal(row.enviado, true);
  assert.equal(f.remote.notifications.size, 1);
});

test('PATCH conflictivo conserva fechas originales y libera guard de cuenta', async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).body;
  f.remote.conflict = true;
  const result = await f.request(`/api/v1/reservas/${created.reservaId}`, {
    method: 'PATCH',
    key: randomUUID(),
    body: { desde: date(60), hasta: date(62) },
  });
  assert.equal(result.status, 409);
  assert.deepEqual(
    (await f.request(`/api/v1/reservas/${created.reservaId}`)).body,
    created,
  );
  assert.equal(f.remote.guards.size, 0);
  assert.equal([...f.remote.holds.values()][0].desde, created.desde);
});

test('PATCH con fallo despues de cambiar inventario conserva guard y reanuda ajuste de cargo', async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).body;
  const key = randomUUID(),
    body = { desde: date(60), hasta: date(63) };
  f.remote.price = '1980.00';
  f.remote.fault = async (base, path, options) => {
    if (path.includes('/cargos/') && options.method === 'PATCH')
      throw new AppError(503, 'DEPENDENCIA_NO_DISPONIBLE', 'Temporal.');
  };
  const pending = await f.request(`/api/v1/reservas/${created.reservaId}`, {
    method: 'PATCH',
    key,
    body,
  });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.estado, 'MODIFICANDO');
  assert.equal(f.remote.guards.size, 1);
  f.remote.fault = null;
  const restarted = createApp({
    db: f.db,
    config,
    tokens,
    logger,
    call: f.remote.call,
  });
  await restarted.locals.coordinator.process(pending.body.operacionId);
  const done = await f.request(`/api/v1/reservas/${created.reservaId}`, {
    method: 'PATCH',
    key,
    body,
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.total, '1980.00');
  assert.equal(done.body.desde, body.desde);
  assert.equal(done.body.estado, 'CONFIRMADA');
  assert.equal(f.remote.guards.size, 0);
  assert.equal([...f.remote.charges.values()][0].monto, '1980.00');
});

test('cuenta pagada rechaza PATCH y cancelacion con409 sin tocar inventario', async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).body;
  f.remote.paid = true;
  const before = f.remote.calls.filter(
    (c) => c.base === config.HABITACIONES_URL,
  ).length;
  for (const method of ['PATCH', 'DELETE']) {
    const result = await f.request(`/api/v1/reservas/${created.reservaId}`, {
      method,
      key: randomUUID(),
      ...(method === 'PATCH' ? { body: { personas: 1 } } : {}),
    });
    assert.equal(result.status, 409);
  }
  assert.deepEqual(
    (await f.request(`/api/v1/reservas/${created.reservaId}`)).body,
    created,
  );
  assert.equal(
    f.remote.calls.filter((c) => c.base === config.HABITACIONES_URL).length,
    before,
  );
});

test('cancelacion anula antes de liberar; fallo de liberacion queda durable hasta recuperar', async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).body;
  const key = randomUUID();
  f.remote.fault = async (base, path, options) => {
    if (base === config.HABITACIONES_URL && options.method === 'DELETE')
      throw new AppError(503, 'DEPENDENCIA_NO_DISPONIBLE', 'Temporal.');
  };
  const pending = await f.request(`/api/v1/reservas/${created.reservaId}`, {
    method: 'DELETE',
    key,
  });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.estado, 'CANCELANDO');
  assert.equal([...f.remote.charges.values()][0].estado, 'ANULADO');
  assert.equal([...f.remote.holds.values()][0].estado, 'CONFIRMADO');
  assert.equal(f.remote.guards.size, 1);
  f.remote.fault = null;
  await f.app.locals.coordinator.process(pending.body.operacionId);
  assert.equal(
    (
      await f.request(`/api/v1/reservas/${created.reservaId}`, {
        method: 'DELETE',
        key,
      })
    ).status,
    204,
  );
  assert.equal(
    (await f.request(`/api/v1/reservas/${created.reservaId}`)).body.estado,
    'CANCELADA',
  );
  assert.equal([...f.remote.holds.values()][0].estado, 'LIBERADO');
  assert.equal(f.remote.guards.size, 0);
});

test('respuesta de cargo perdida se recupera con la misma clave sin duplicar ni liberar inventario', async (t) => {
  const f = await fixture(t);
  const body = input(),
    key = randomUUID();
  f.remote.fault = async (base, path, options) => {
    if (path === '/api/v1/interno/cargos') {
      f.remote.charges.set(options.key, {
        cargoId: randomUUID(),
        ...options.body,
        estado: 'ACTIVO',
      });
      throw new AppError(
        503,
        'DEPENDENCIA_NO_DISPONIBLE',
        'La respuesta se perdio tras persistir.',
      );
    }
  };
  const pending = await f.create(body, key);
  assert.equal(pending.status, 202);
  assert.equal(f.remote.charges.size, 1);
  assert.equal([...f.remote.holds.values()][0].estado, 'CONFIRMADO');
  f.remote.fault = null;
  const restarted = createApp({
    db: f.db,
    config,
    tokens,
    logger,
    call: f.remote.call,
  });
  await restarted.locals.coordinator.process(pending.body.operacionId);
  assert.equal((await f.create(body, key)).status, 201);
  assert.equal(f.remote.charges.size, 1);
  assert.equal(
    f.remote.calls.some(
      (c) => c.base === config.HABITACIONES_URL && c.method === 'DELETE',
    ),
    false,
  );
});

test('operaciones concurrentes de una reserva se excluyen mientras una dependencia espera', async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).body;
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  f.remote.fault = async (base, path, options) => {
    if (path.includes('/cuentas/') && options.method === 'PUT') {
      entered();
      await waiting;
    }
  };
  const changing = f.request(`/api/v1/reservas/${created.reservaId}`, {
    method: 'PATCH',
    key: randomUUID(),
    body: { personas: 1 },
  });
  await enteredPromise;
  try {
    const cancel = await f.request(`/api/v1/reservas/${created.reservaId}`, {
      method: 'DELETE',
      key: randomUUID(),
    });
    assert.equal(cancel.status, 409);
  } finally {
    release();
  }
  assert.equal((await changing).status, 200);
  assert.equal(
    (await f.request(`/api/v1/reservas/${created.reservaId}`)).body.estado,
    'CONFIRMADA',
  );
});

for (const method of ['PATCH', 'DELETE']) {
  test(`dos ${method} simultaneos con misma clave comparten la operacion persistida`, async (t) => {
    const key = randomUUID();
    const f = await fixture(t, { postgres: true, barrierKey: key });
    const created = (await f.create()).body;
    const options = {
      method,
      key,
      ...(method === 'PATCH' ? { body: { personas: 1 } } : {}),
    };
    const path = `/api/v1/reservas/${created.reservaId}`;
    const results = await Promise.all([
      f.request(path, options),
      f.request(path, options),
    ]);
    const expected = method === 'PATCH' ? 200 : 204;
    for (const result of results)
      assert.ok(
        [expected, 202].includes(result.status),
        JSON.stringify(result),
      );
    const replay = await f.request(path, options);
    assert.equal(replay.status, expected);
    const operations = (
      await f.db.query(
        'SELECT operacion_id,estado FROM reservas.operaciones WHERE reserva_id=$1 AND accion=$2',
        [created.reservaId, method === 'PATCH' ? 'MODIFICAR' : 'CANCELAR'],
      )
    ).rows;
    assert.equal(operations.length, 1);
    assert.equal(operations[0].estado, 'COMPLETA');
    for (const result of results) {
      if (result.status === 202)
        assert.equal(result.body.operacionId, operations[0].operacion_id);
      else assert.deepEqual(result, replay);
    }
    if (process.env.TEST_RESERVAS_DATABASE_URL)
      assert.equal(f.concurrency.arrivals(), 2);
    assert.equal(
      f.remote.calls.filter(
        (c) => c.path.includes('/cuentas/') && c.method === 'PUT',
      ).length,
      1,
    );
  });
}
