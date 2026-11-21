import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { createPool } from '../../shared/database.js';
import { createVerifier } from '../../shared/security.js';
import { AppError } from '../../shared/errors.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { createNotificationWorker } from '../src/notifications.js';
import { loadConfig } from '../src/config.js';

const OWNER = randomUUID(),
  OTHER = randomUUID();
const SERVICE = 'solo-pruebas-servicio-de-confianza-0123456789';
const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const config = {
  SERVICE_TOKEN: SERVICE,
  JWT_PUBLIC_KEY_BASE64: Buffer.from(pair.publicKey).toString('base64'),
  JWT_ISSUER: 'resort-clientes',
  JWT_AUDIENCE: 'resort-api',
};
const reservations = new Map();
const logs = [];
const logger = { info: (v) => logs.push(v), error: (v) => logs.push(v) };
let db, server, base, ownerToken, otherToken, privateKey;
let resolverUnavailable = false;
async function sign(sub = OWNER, claims = {}) {
  return new SignJWT({ rol: 'HUESPED', ...claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .setJti(randomUUID())
    .sign(privateKey);
}
function reservation(owner = OWNER, state = 'CONFIRMADA') {
  const id = randomUUID();
  reservations.set(id, { reservaId: id, huespedId: owner, estado: state });
  return id;
}
async function request(
  path,
  { method = 'GET', body, token = ownerToken, key, headers = {} } = {},
) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return {
    status: r.status,
    body: text ? JSON.parse(text) : null,
    headers: r.headers,
  };
}
async function cargo(id, monto = '660.00', options = {}) {
  return request('/api/v1/interno/cargos', {
    method: 'POST',
    token: SERVICE,
    key: options.key ?? randomUUID(),
    body: {
      reservaId: id,
      origen: 'HABITACION',
      origenId: options.origenId ?? id,
      concepto: 'Estadia',
      monto,
      moneda: 'PEN',
      ...options.body,
    },
  });
}
function pay(id, monto = '660.00', options = {}) {
  return request('/api/v1/pagos', {
    method: 'POST',
    key: options.key ?? randomUUID(),
    token: options.token ?? ownerToken,
    body: {
      reservaId: id,
      monto,
      metodo: 'SIMULADO',
      tokenPago: options.paymentToken ?? 'tok_aprobado',
      ...options.body,
    },
  });
}
const internal = (path, method, body, key = randomUUID(), headers = {}) =>
  request(`/api/v1/interno${path}`, {
    method,
    body,
    key,
    token: SERVICE,
    headers,
  });

before(async () => {
  privateKey = await importPKCS8(pair.privateKey, 'RS256');
  ownerToken = await sign();
  otherToken = await sign(OTHER);
  db = process.env.TEST_PAGOS_DATABASE_URL
    ? createPool(process.env.TEST_PAGOS_DATABASE_URL)
    : new PGlite();
  await migrate(db);
  const app = createApp({
    db,
    tokens: await createVerifier(config),
    config,
    logger,
    resolveReservation: async (id) => {
      if (resolverUnavailable)
        throw new AppError(
          503,
          'RESERVAS_NO_DISPONIBLE',
          'Dependencia temporalmente no disponible.',
        );
      const r = reservations.get(id);
      if (!r)
        throw new AppError(
          404,
          'RESERVA_NO_ENCONTRADA',
          'No se encontro la reserva.',
        );
      return r;
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await db.end?.();
  await db.close?.();
});

test('health verifica persistencia y middleware de seguridad', async () => {
  const r = await request('/health/ready', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.servicio, 'pagos-notificaciones');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});
test('consultar cuenta requiere JWT y rechaza acceso ajeno', async () => {
  const id = reservation();
  await cargo(id);
  assert.equal(
    (await request(`/api/v1/cuentas/${id}`, { token: null })).status,
    401,
  );
  assert.equal(
    (await request(`/api/v1/cuentas/${id}`, { token: otherToken })).status,
    403,
  );
  assert.equal(
    (await request(`/api/v1/cuentas/${id}`, { token: SERVICE })).status,
    401,
  );
  const r = await request(`/api/v1/cuentas/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.saldo, '660.00');
});
test('JWT con firma o rol incorrectos no autentica al huesped', async () => {
  const id = reservation();
  assert.equal(
    (
      await request(`/api/v1/cuentas/${id}`, {
        token: await sign(OWNER, { rol: 'ADMIN' }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(`/api/v1/cuentas/${id}`, {
        token: `${ownerToken.slice(0, -8)}alterado`,
      })
    ).status,
    401,
  );
});
test('operaciones internas requieren token de servicio y UUID de idempotencia', async () => {
  const id = reservation();
  assert.equal(
    (
      await request('/api/v1/interno/cargos', {
        method: 'POST',
        token: ownerToken,
        body: {},
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/api/v1/interno/cargos', {
        method: 'POST',
        token: SERVICE,
        body: {
          reservaId: id,
          origen: 'HABITACION',
          origenId: id,
          concepto: 'Estadia',
          monto: '1.00',
        },
      })
    ).status,
    400,
  );
});
test('cargos son idempotentes y deduplican origen; payload distinto no se mezcla', async () => {
  const id = reservation(),
    key = randomUUID();
  const a = await cargo(id, '0.10', { key });
  const b = await cargo(id, '0.10', { key });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body, b.body);
  assert.equal((await cargo(id, '0.11', { key })).status, 409);
  const sameOrigin = await cargo(id, '0.10');
  assert.equal(sameOrigin.body.cargoId, a.body.cargoId);
  assert.equal((await cargo(id, '0.12')).status, 409);
  const account = (await request(`/api/v1/cuentas/${id}`)).body;
  assert.equal(account.cargos.length, 1);
  assert.equal(account.total, '0.10');
});
test('los importes se suman exactamente sin coma flotante', async () => {
  const id = reservation();
  await cargo(id, '0.10');
  await cargo(id, '0.20', { origenId: randomUUID() });
  const r = await request(`/api/v1/cuentas/${id}`);
  assert.equal(r.body.total, '0.30');
  const key = randomUUID();
  assert.equal((await pay(id, '0.29', { key })).status, 422);
  const paid = await pay(id, '0.30', { key });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.estado, 'APROBADO');
  assert.equal((await request(`/api/v1/cuentas/${id}`)).body.saldo, '0.00');
});
test('pago idempotente guarda resultado y no conserva tokenPago', async () => {
  const id = reservation(),
    key = randomUUID();
  await cargo(id);
  const a = await pay(id, '660.00', { key });
  const b = await pay(id, '660.00', { key });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body, b.body);
  assert.equal(
    (await pay(id, '660.00', { key, paymentToken: 'tok_rechazado' })).status,
    409,
  );
  assert.equal((await pay(id)).status, 409);
  const rows = (
    await db.query('SELECT * FROM pagos.pagos WHERE reserva_id=$1', [id])
  ).rows;
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /tok_aprobado|tokenPago/);
  assert.equal((await request(`/api/v1/cuentas/${id}`)).body.pagado, '660.00');
});
test('replay de pago persistido no depende de Reservas y mantiene aislamiento por huesped', async () => {
  const id = reservation(),
    key = randomUUID();
  await cargo(id);
  const approved = await pay(id, '660.00', { key });
  assert.equal(approved.status, 201);
  resolverUnavailable = true;
  try {
    const replay = await pay(id, '660.00', { key });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, approved.body);
    assert.equal((await pay(id, '660.01', { key })).status, 409);
    assert.equal(
      (await pay(id, '660.00', { key, token: otherToken })).status,
      503,
    );
    assert.equal((await pay(id)).status, 503);
  } finally {
    resolverUnavailable = false;
  }
});

test('dos pagos concurrentes con claves distintas no cobran dos veces', async () => {
  const id = reservation();
  await cargo(id);
  const result = await Promise.all([pay(id), pay(id)]);
  assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM pagos.pagos WHERE reserva_id=$1 AND estado='APROBADO'",
        [id],
      )
    ).rows[0].n,
    1,
  );
});
test('pago rechazado es persistente y no descuenta saldo', async () => {
  const id = reservation(),
    key = randomUUID();
  await cargo(id);
  const a = await pay(id, '660.00', { key, paymentToken: 'tok_rechazado' });
  assert.equal(a.status, 201);
  assert.equal(a.body.estado, 'RECHAZADO');
  assert.deepEqual(
    (await pay(id, '660.00', { key, paymentToken: 'tok_rechazado' })).body,
    a.body,
  );
  assert.equal((await request(`/api/v1/cuentas/${id}`)).body.saldo, '660.00');
  assert.equal((await pay(id)).body.estado, 'APROBADO');
});
test('no acepta tarjeta, monto numerico, token desconocido ni propietario arbitrario', async () => {
  const id = reservation();
  await cargo(id);
  for (const body of [
    { monto: 660 },
    { numeroTarjeta: '4111111111111111' },
    { tokenPago: 'tarjeta-real' },
    { huespedId: OTHER },
  ])
    assert.equal((await pay(id, '660.00', { body })).status, 400);
  assert.equal((await pay(id, '660.00', { token: otherToken })).status, 403);
  reservations.get(id).estado = 'CANCELADA';
  assert.equal((await pay(id)).status, 409);
});
test('bloqueo durable de cuenta excluye pagos y permite modificar cargo propio de operacion', async () => {
  const id = reservation(),
    op = randomUUID();
  const c = (await cargo(id)).body;
  assert.equal(
    (await internal(`/cuentas/${id}/operacion`, 'PUT', { operacionId: op }))
      .status,
    200,
  );
  assert.equal((await pay(id)).status, 409);
  assert.equal(
    (
      await internal(`/cuentas/${id}/operacion`, 'PUT', {
        operacionId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await internal(`/cargos/${c.cargoId}`, 'PATCH', {
        operacionId: randomUUID(),
        monto: '700.00',
        concepto: 'Cambio',
      })
    ).status,
    409,
  );
  const update = await internal(`/cargos/${c.cargoId}`, 'PATCH', {
    operacionId: op,
    monto: '700.00',
    concepto: 'Cambio',
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.monto, '700.00');
  const audit = (
    await db.query(
      "SELECT detalle FROM pagos.auditoria WHERE recurso_id=$1 AND accion='CARGO_MODIFICADO'",
      [c.cargoId],
    )
  ).rows[0].detalle;
  assert.equal(audit.anterior.monto, '660.00');
  assert.equal(audit.actual.monto, '700.00');
  assert.equal(
    (await internal(`/cuentas/${id}/operacion/${randomUUID()}`, 'DELETE'))
      .status,
    409,
  );
  assert.equal(
    (await internal(`/cuentas/${id}/operacion/${op}`, 'DELETE')).status,
    204,
  );
  assert.equal((await pay(id, '700.00')).status, 201);
});
test('anulacion preserva historial; cuenta pagada rechaza bloqueo y anulacion', async () => {
  const id = reservation(),
    op = randomUUID();
  const c = (await cargo(id)).body;
  await internal(`/cuentas/${id}/operacion`, 'PUT', { operacionId: op });
  assert.equal((await internal(`/cargos/${c.cargoId}`, 'DELETE')).status, 409);
  assert.equal(
    (
      await internal(
        `/cargos/${c.cargoId}`,
        'DELETE',
        undefined,
        randomUUID(),
        { 'X-Operacion-Id': op },
      )
    ).status,
    204,
  );
  const a = (await request(`/api/v1/cuentas/${id}`)).body;
  assert.equal(a.total, '0.00');
  assert.equal(a.cargos[0].estado, 'ANULADO');
  const paid = reservation();
  const pc = (await cargo(paid)).body;
  await pay(paid);
  assert.equal((await internal(`/cargos/${pc.cargoId}`, 'DELETE')).status, 409);
  assert.equal(
    (
      await internal(`/cuentas/${paid}/operacion`, 'PUT', {
        operacionId: randomUUID(),
      })
    ).status,
    409,
  );
});
test('pago y bloqueo concurrentes terminan en una unica decision coherente', async () => {
  const id = reservation(),
    op = randomUUID();
  await cargo(id);
  const result = await Promise.all([
    pay(id),
    internal(`/cuentas/${id}/operacion`, 'PUT', { operacionId: op }),
  ]);
  assert.equal(
    result.filter((r) => r.status >= 200 && r.status < 300).length,
    1,
  );
  assert.equal(result.filter((r) => r.status === 409).length, 1);
});
test('el total de cuenta no puede exceder numeric12 y claves de pago tienen alcance por huesped', async () => {
  const max = reservation();
  assert.equal((await cargo(max, '9999999999.99')).status, 201);
  assert.equal(
    (await cargo(max, '0.01', { origenId: randomUUID() })).status,
    422,
  );
  const first = reservation(),
    second = reservation(OTHER),
    key = randomUUID();
  await cargo(first, '1.00');
  await cargo(second, '2.00');
  assert.equal((await pay(first, '1.00', { key })).status, 201);
  assert.equal(
    (await pay(second, '2.00', { key, token: otherToken })).status,
    201,
  );
});
test('avisos deduplican evento y verifican propiedad del huesped', async () => {
  const id = reservation(),
    event = randomUUID(),
    key = randomUUID();
  const input = { reservaId: id, eventoId: event, tipo: 'ReservaConfirmada' };
  const a = await internal('/notificaciones', 'POST', input, key);
  const b = await internal('/notificaciones', 'POST', input);
  assert.equal(a.status, 202);
  assert.equal(a.body.notificacionId, b.body.notificacionId);
  assert.equal(
    (
      await internal('/notificaciones', 'POST', {
        ...input,
        tipo: 'PagoConfirmado',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/api/v1/notificaciones/${a.body.notificacionId}`, {
        token: otherToken,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(`/api/v1/notificaciones/${a.body.notificacionId}`)).body
      .estado,
    'PENDIENTE',
  );
});
test('worker conserva reintentos tras fallo, recupera cola y deduplica entrega simulada', async () => {
  // Otros tests pueden haber encolado avisos: se procesan primero con el simulador.
  const process = createNotificationWorker({ db, logger });
  await process({ batchSize: 100 });
  const id = reservation();
  const input = {
    reservaId: id,
    eventoId: randomUUID(),
    tipo: 'ReservaConfirmada',
  };
  const n = (await internal('/notificaciones', 'POST', input)).body;
  const failing = createNotificationWorker({
    db,
    logger,
    sender: async () => {
      throw new Error('proveedor no disponible');
    },
  });
  assert.equal(await failing({ batchSize: 1 }), 1);
  let row = (
    await db.query(
      'SELECT * FROM pagos.notificaciones WHERE notificacion_id=$1',
      [n.notificacionId],
    )
  ).rows[0];
  assert.equal(row.estado, 'PENDIENTE');
  assert.equal(row.intentos, 1);
  await db.query(
    'UPDATE pagos.notificaciones SET proximo_intento_en=now() WHERE notificacion_id=$1',
    [n.notificacionId],
  );
  const restarted = createNotificationWorker({ db, logger });
  assert.equal(await restarted(), 1);
  row = (
    await db.query(
      'SELECT * FROM pagos.notificaciones WHERE notificacion_id=$1',
      [n.notificacionId],
    )
  ).rows[0];
  assert.equal(row.estado, 'ENVIADA');
  assert.equal(row.intentos, 2);
  // Simula crash tras entrega y antes del ack: el receipt local evita duplicado.
  await db.query(
    "UPDATE pagos.notificaciones SET estado='PENDIENTE',enviada_en=NULL,proximo_intento_en=now() WHERE notificacion_id=$1",
    [n.notificacionId],
  );
  await restarted();
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM pagos.entregas_simuladas WHERE evento_id=$1',
        [input.eventoId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await request(`/api/v1/notificaciones/${n.notificacionId}`)).body.estado,
    'ENVIADA',
  );
});
test('worker agota intentos sin borrar aviso y recupera lease de proceso anterior', async () => {
  const id = reservation();
  const n = (
    await internal('/notificaciones', 'POST', {
      reservaId: id,
      eventoId: randomUUID(),
      tipo: 'ReservaConfirmada',
    })
  ).body;
  await db.query(
    "UPDATE pagos.notificaciones SET intentos=4,bloqueada_hasta=now()-interval '1 minute' WHERE notificacion_id=$1",
    [n.notificacionId],
  );
  const failing = createNotificationWorker({
    db,
    logger,
    sender: async () => {
      throw new Error('proveedor');
    },
  });
  await failing({ batchSize: 100 });
  const failed = (await request(`/api/v1/notificaciones/${n.notificacionId}`))
    .body;
  assert.equal(failed.estado, 'FALLIDA');
  assert.equal(failed.intentos, 5);
  const restarted = createNotificationWorker({ db, logger });
  assert.equal(await restarted(), 0);
});
test('simuladores requieren activacion explicita y logs no contienen credenciales', () => {
  const env = {
    ...config,
    PAGOS_DATABASE_URL: 'postgresql://test:test@localhost/test',
    RESERVAS_URL: 'http://localhost:3003',
  };
  assert.throws(() => loadConfig(env), /ALLOW_SIMULATED_PROVIDERS/);
  assert.equal(
    loadConfig({ ...env, ALLOW_SIMULATED_PROVIDERS: 'true' }).PAGOS_PORT,
    3004,
  );
  assert.throws(
    () =>
      loadConfig({
        ...env,
        NODE_ENV: 'production',
        ALLOW_SIMULATED_PROVIDERS: 'true',
      }),
    /prohibidos en produccion/,
  );
  const all = logs.join('\n');
  assert.doesNotMatch(
    all,
    /tok_aprobado|tok_rechazado|Bearer |BEGIN PRIVATE KEY|solo-pruebas-servicio/,
  );
});
