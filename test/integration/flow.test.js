import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { createPool } from '../../services/shared/database.js';
import { createVerifier } from '../../services/shared/security.js';
import { callService } from '../../services/shared/client.js';
import { AppError } from '../../services/shared/errors.js';
import { createTokens } from '../../services/clientes/src/security/tokens.js';
import { createApp as clientesApp } from '../../services/clientes/src/app.js';
import { createApp as habitacionesApp } from '../../services/habitaciones/src/app.js';
import { createApp as reservasApp } from '../../services/reservas/src/app.js';
import { createApp as pagosApp } from '../../services/pagos-notificaciones/src/app.js';
import { migrate as migrateClientes } from '../../services/clientes/src/migrate.js';
import { migrate as migrateHabitaciones } from '../../services/habitaciones/src/migrate.js';
import { migrate as migrateReservas } from '../../services/reservas/src/migrate.js';
import { migrate as migratePagos } from '../../services/pagos-notificaciones/src/migrate.js';

const logs = [];
const logger = { info: (s) => logs.push(s), error: (s) => logs.push(s) };
const serviceToken = 'prueba-integracion-servicios-' + randomUUID();
const password = 'ClaveDePruebaSegura-2026!';
const rooms = {
  suite: '11111111-1111-4111-8111-111111111301',
  familiar: '11111111-1111-4111-8111-111111111202',
};
const databases = [];
const servers = [];
const bases = {};
let reservas,
  pagos,
  token,
  otherToken,
  clientId,
  reservation,
  lostChargeResponses = 0;

function future(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
async function listen(name, app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  bases[name] = `http://127.0.0.1:${server.address().port}`;
}
async function request(
  service,
  path,
  { method = 'GET', body, bearer, key, headers = {} } = {},
) {
  const response = await fetch(new URL(path, bases[service]), {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}
async function register() {
  const email = `integracion-${randomUUID()}@example.com`;
  const created = await request('clientes', '/api/v1/clientes', {
    method: 'POST',
    body: { nombre: 'Integración Académica', email, password },
  });
  assert.equal(created.status, 201);
  const login = await request('clientes', '/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(login.status, 200);
  return { token: login.body.accessToken, id: created.body.clienteId };
}
async function createReservation(
  day,
  { room = rooms.suite, key = randomUUID() } = {},
) {
  return request('reservas', '/api/v1/reservas', {
    method: 'POST',
    bearer: token,
    key,
    body: {
      habitacionId: room,
      desde: future(day),
      hasta: future(day + 2),
      personas: 2,
    },
  });
}

before(async () => {
  const settings = [
    ['TEST_DATABASE_URL', migrateClientes],
    ['TEST_HABITACIONES_DATABASE_URL', migrateHabitaciones],
    ['TEST_RESERVAS_DATABASE_URL', migrateReservas],
    ['TEST_PAGOS_DATABASE_URL', migratePagos],
  ];
  for (const [env, migrate] of settings) {
    const db = process.env[env]
      ? createPool(process.env[env])
      : new PGlite({ extensions: { btree_gist } });
    databases.push(db);
    await migrate(db);
  }
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const config = {
    JWT_PRIVATE_KEY_BASE64: Buffer.from(pair.privateKey).toString('base64'),
    JWT_PUBLIC_KEY_BASE64: Buffer.from(pair.publicKey).toString('base64'),
    JWT_ISSUER: 'resort-clientes',
    JWT_AUDIENCE: 'resort-api',
    JWT_TTL_SECONDS: 900,
  };
  await listen(
    'clientes',
    await clientesApp({
      db: databases[0],
      tokens: await createTokens(config),
      config,
      logger,
    }),
  );
  await listen(
    'habitaciones',
    habitacionesApp({
      db: databases[1],
      config: { SERVICE_TOKEN: serviceToken, BLOQUEO_TTL_SECONDS: 600 },
      logger,
    }),
  );
  const verifier = await createVerifier(config);
  const paymentConfig = { SERVICE_TOKEN: serviceToken };
  pagos = pagosApp({
    db: databases[3],
    tokens: verifier,
    config: paymentConfig,
    logger,
  });
  await listen('pagos', pagos);
  reservas = reservasApp({
    db: databases[2],
    tokens: verifier,
    config: {
      SERVICE_TOKEN: serviceToken,
      HABITACIONES_URL: bases.habitaciones,
      PAGOS_URL: bases.pagos,
    },
    logger,
    call: async (base, path, options) => {
      const result = await callService(base, path, options);
      // El cargo sí se confirma remotamente; simulamos perder la respuesta antes de
      // guardar la fase local. La recuperación debe reutilizar la misma clave.
      if (path === '/api/v1/interno/cargos' && lostChargeResponses > 0) {
        lostChargeResponses -= 1;
        throw new AppError(
          503,
          'RESPUESTA_PERDIDA',
          'Respuesta perdida de prueba.',
        );
      }
      return result;
    },
  });
  await listen('reservas', reservas);
  paymentConfig.RESERVAS_URL = bases.reservas;
  const first = await register();
  token = first.token;
  clientId = first.id;
  otherToken = (await register()).token;
});

after(async () => {
  await reservas?.locals.coordinator.stop();
  for (const server of servers.reverse())
    await new Promise((resolve) => server.close(resolve));
  for (const db of databases.reverse()) {
    await db.end?.();
    await db.close?.();
  }
});

test('cuatro APIs reales: identidad, inventario, reserva, cargo y aviso correlacionados', async () => {
  const profile = await request('clientes', `/api/v1/clientes/${clientId}`, {
    bearer: token,
  });
  assert.equal(profile.status, 200);
  const traceId = randomUUID();
  const created = await request('reservas', '/api/v1/reservas', {
    method: 'POST',
    bearer: token,
    key: randomUUID(),
    headers: { 'X-Request-Id': traceId },
    body: {
      habitacionId: rooms.suite,
      desde: future(5000),
      hasta: future(5002),
      personas: 2,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  reservation = created.body;
  assert.equal(reservation.estado, 'CONFIRMADA');
  assert.equal(reservation.huespedId, clientId);
  assert.equal(reservation.total, '1320.00');
  const account = await request(
    'pagos',
    `/api/v1/cuentas/${reservation.reservaId}`,
    { bearer: token },
  );
  assert.equal(account.status, 200);
  assert.equal(account.body.saldo, '1320.00');
  assert.equal(
    account.body.cargos.filter((c) => c.estado === 'ACTIVO').length,
    1,
  );
  await reservas.locals.coordinator.dispatch();
  await pagos.locals.processNotifications();
  const notice = (
    await databases[3].query(
      'SELECT notificacion_id,estado FROM pagos.notificaciones WHERE reserva_id=$1',
      [reservation.reservaId],
    )
  ).rows[0];
  assert.equal(notice.estado, 'ENVIADA');
  assert.equal(
    (
      await request(
        'pagos',
        `/api/v1/notificaciones/${notice.notificacion_id}`,
        { bearer: token },
      )
    ).status,
    200,
  );
  assert.ok(
    logs.some((s) => s.includes(traceId) && s.includes('habitaciones')),
  );
  assert.ok(
    logs.some((s) => s.includes(traceId) && s.includes('pagos-notificaciones')),
  );
});

test('autorización en cada dominio y rechazo de identidad/montos suministrados por cliente', async () => {
  assert.equal(
    (
      await request('reservas', `/api/v1/reservas/${reservation.reservaId}`, {
        bearer: otherToken,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request('pagos', `/api/v1/cuentas/${reservation.reservaId}`, {
        bearer: otherToken,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('pagos', '/api/v1/interno/cargos', {
        method: 'POST',
        bearer: token,
        body: {},
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('reservas', '/api/v1/reservas', {
        method: 'POST',
        bearer: token,
        key: randomUUID(),
        body: {
          habitacionId: rooms.suite,
          desde: future(5100),
          hasta: future(5102),
          personas: 2,
          huespedId: randomUUID(),
          total: '0.01',
        },
      })
    ).status,
    400,
  );
  const badAmount = await request('pagos', '/api/v1/pagos', {
    method: 'POST',
    bearer: token,
    key: randomUUID(),
    body: {
      reservaId: reservation.reservaId,
      monto: '0.01',
      metodo: 'SIMULADO',
      tokenPago: 'tok_aprobado',
    },
  });
  assert.equal(badAmount.status, 422);
});

test('modificar fechas actualiza inventario y cargo; conflicto preserva reserva original', async () => {
  const changed = await request(
    'reservas',
    `/api/v1/reservas/${reservation.reservaId}`,
    {
      method: 'PATCH',
      bearer: token,
      key: randomUUID(),
      body: { hasta: future(5003) },
    },
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.total, '1980.00');
  const account = await request(
    'pagos',
    `/api/v1/cuentas/${reservation.reservaId}`,
    { bearer: token },
  );
  assert.equal(account.body.saldo, '1980.00');
  const competitor = await createReservation(5010);
  assert.equal(competitor.status, 201);
  const rejected = await request(
    'reservas',
    `/api/v1/reservas/${reservation.reservaId}`,
    {
      method: 'PATCH',
      bearer: token,
      key: randomUUID(),
      body: { desde: future(5009), hasta: future(5012) },
    },
  );
  assert.equal(rejected.status, 409);
  const still = await request(
    'reservas',
    `/api/v1/reservas/${reservation.reservaId}`,
    { bearer: token },
  );
  assert.equal(still.body.estado, 'CONFIRMADA');
  assert.equal(still.body.hasta, future(5003));
  assert.equal(
    (
      await request(
        'reservas',
        `/api/v1/reservas/${competitor.body.reservaId}`,
        { method: 'DELETE', bearer: token, key: randomUUID() },
      )
    ).status,
    204,
  );
});

test('cobro rechazado no debita; pago concurrente idempotente no duplica y evita cancelación pagada', async () => {
  const body = {
    reservaId: reservation.reservaId,
    monto: '1980.00',
    metodo: 'SIMULADO',
    tokenPago: 'tok_rechazado',
  };
  const rejected = await request('pagos', '/api/v1/pagos', {
    method: 'POST',
    bearer: token,
    key: randomUUID(),
    body,
  });
  assert.equal(rejected.status, 201);
  assert.equal(rejected.body.estado, 'RECHAZADO');
  const key = randomUUID();
  const options = {
    method: 'POST',
    bearer: token,
    key,
    body: { ...body, tokenPago: 'tok_aprobado' },
  };
  const paid = await Promise.all([
    request('pagos', '/api/v1/pagos', options),
    request('pagos', '/api/v1/pagos', options),
  ]);
  assert.deepEqual(
    paid.map((p) => p.status),
    [201, 201],
  );
  assert.equal(paid[0].body.pagoId, paid[1].body.pagoId);
  assert.equal(
    (
      await request('pagos', `/api/v1/cuentas/${reservation.reservaId}`, {
        bearer: token,
      })
    ).body.saldo,
    '0.00',
  );
  const cancel = await request(
    'reservas',
    `/api/v1/reservas/${reservation.reservaId}`,
    { method: 'DELETE', bearer: token, key: randomUUID() },
  );
  assert.equal(cancel.status, 409);
  assert.equal(
    (
      await request('reservas', `/api/v1/reservas/${reservation.reservaId}`, {
        bearer: token,
      })
    ).body.estado,
    'CONFIRMADA',
  );
});

test('respuesta de cargo perdida se recupera sin duplicar y sobrevive al reinicio del coordinador', async () => {
  lostChargeResponses = 1;
  const created = await createReservation(5200, { room: rooms.familiar });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.reservaId;
  const before = await databases[3].query(
    'SELECT count(*)::int AS n FROM pagos.cargos WHERE reserva_id=$1',
    [id],
  );
  assert.equal(before.rows[0].n, 1);
  // Un nuevo coordinador lee las fases persistidas, sin memoria del request anterior.
  const { createCoordinator } =
    await import('../../services/reservas/src/saga.js');
  const restarted = createCoordinator(
    reservas.locals.repository,
    {
      SERVICE_TOKEN: serviceToken,
      HABITACIONES_URL: bases.habitaciones,
      PAGOS_URL: bases.pagos,
    },
    { logger },
  );
  await restarted.process(created.body.operacionId);
  const recovered = await request('reservas', `/api/v1/reservas/${id}`, {
    bearer: token,
  });
  assert.equal(recovered.body.estado, 'CONFIRMADA');
  assert.equal(
    (
      await databases[3].query(
        'SELECT count(*)::int AS n FROM pagos.cargos WHERE reserva_id=$1',
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await request('reservas', `/api/v1/reservas/${id}`, {
        method: 'DELETE',
        bearer: token,
        key: randomUUID(),
      })
    ).status,
    204,
  );
  assert.equal(
    (await request('pagos', `/api/v1/cuentas/${id}`, { bearer: token })).body
      .saldo,
    '0.00',
  );
});

test('concurrencia de reserva por inventario y logs sin secretos', async () => {
  const results = await Promise.all([
    createReservation(5300),
    createReservation(5300),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const allLogs = logs.join('\n');
  for (const secret of [
    password,
    serviceToken,
    token,
    otherToken,
    'tok_aprobado',
    'tok_rechazado',
  ])
    assert.equal(allLogs.includes(secret), false);
});
