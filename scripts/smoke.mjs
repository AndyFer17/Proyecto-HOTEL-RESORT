import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const gateway = process.env.TEST_GATEWAY_URL ?? 'http://127.0.0.1:8080';
const bases = {
  clientes: process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001',
  habitaciones: process.env.TEST_HABITACIONES_URL ?? 'http://127.0.0.1:3002',
  reservas: process.env.TEST_RESERVAS_URL ?? 'http://127.0.0.1:3003',
  pagos: process.env.TEST_PAGOS_URL ?? 'http://127.0.0.1:3004',
};
let token;
async function request(
  service,
  path,
  { method = 'GET', body, key, auth = true, direct = false } = {},
) {
  const response = await fetch(
    `${!direct && gateway ? gateway : bases[service]}${path}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    },
  );
  return {
    status: response.status,
    body: response.status === 204 ? undefined : await response.json(),
  };
}
async function waitFor(service, path, test, description) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request(service, path);
    if (test(result)) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No se completo: ${description}.`);
}
function dates(offset) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + offset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 2);
  return {
    desde: start.toISOString().slice(0, 10),
    hasta: end.toISOString().slice(0, 10),
    personas: 2,
  };
}

// Este script agrega datos ficticios. Apuntar solamente a una demo local.
for (const service of Object.keys(bases)) {
  const ready = await request(service, '/health/ready', {
    direct: true,
    auth: false,
  });
  assert.equal(ready.status, 200, `readiness de ${service}`);
}
if (gateway) {
  const ready = await fetch(`${gateway}/health/ready`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(ready.status, 200, 'readiness del gateway');
  const blocked = await fetch(
    `${gateway}/api/v1/interno/reservas/${randomUUID()}/titular`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert.equal(blocked.status, 404, 'el gateway oculta endpoints internos');
}

const input = {
  nombre: 'Huesped Smoke',
  email: `smoke-${randomUUID()}@example.com`,
  password: 'Prueba-temporal-2026!',
};
const registered = await request('clientes', '/api/v1/clientes', {
  method: 'POST',
  body: input,
});
assert.equal(registered.status, 201);
const client = registered.body;
const login = await request('clientes', '/api/v1/auth/login', {
  method: 'POST',
  body: { email: input.email, password: input.password },
});
assert.equal(login.status, 200);
token = login.body.accessToken;
const profile = await request(
  'clientes',
  `/api/v1/clientes/${client.clienteId}`,
);
assert.equal(profile.status, 200);
assert.equal(profile.body.email, input.email);

const offset = 30 + Math.floor(Math.random() * 330);
async function reserve(range) {
  const available = await request(
    'habitaciones',
    `/api/v1/habitaciones/disponibilidad?${new URLSearchParams(range)}`,
  );
  assert.equal(available.status, 200);
  assert.ok(
    available.body.habitaciones.length > 0,
    'habitaciones disponibles para la demo',
  );
  const body = {
    habitacionId: available.body.habitaciones[0].habitacionId,
    ...range,
  };
  const key = randomUUID();
  const created = await request('reservas', '/api/v1/reservas', {
    method: 'POST',
    body,
    key,
  });
  assert.ok(
    [201, 202].includes(created.status),
    `creacion de reserva: ${created.status}`,
  );
  const confirmed = await waitFor(
    'reservas',
    `/api/v1/reservas/${created.body.reservaId}`,
    (r) => r.status === 200 && r.body.estado === 'CONFIRMADA',
    'reserva confirmada',
  );
  const replay = await request('reservas', '/api/v1/reservas', {
    method: 'POST',
    body,
    key,
  });
  assert.equal(
    replay.body.reservaId,
    confirmed.reservaId,
    'creacion idempotente',
  );
  return confirmed;
}
const reservation = await reserve(dates(offset));
const accountPath = `/api/v1/cuentas/${reservation.reservaId}`;
const account = await request('pagos', accountPath);
assert.equal(account.status, 200);
assert.equal(account.body.saldo, reservation.total);
const unauthorized = await request('pagos', accountPath, { auth: false });
assert.equal(unauthorized.status, 401);

const payment = {
  reservaId: reservation.reservaId,
  monto: account.body.saldo,
  metodo: 'SIMULADO',
};
const rejected = await request('pagos', '/api/v1/pagos', {
  method: 'POST',
  body: { ...payment, tokenPago: 'tok_rechazado' },
  key: randomUUID(),
});
assert.equal(rejected.status, 201);
assert.equal(rejected.body.estado, 'RECHAZADO');
assert.equal(
  (await request('pagos', accountPath)).body.saldo,
  account.body.saldo,
);

const paymentKey = randomUUID();
const paymentBody = { ...payment, tokenPago: 'tok_aprobado' };
const approved = await request('pagos', '/api/v1/pagos', {
  method: 'POST',
  body: paymentBody,
  key: paymentKey,
});
assert.equal(approved.status, 201);
assert.equal(approved.body.estado, 'APROBADO');
const replayPayment = await request('pagos', '/api/v1/pagos', {
  method: 'POST',
  body: paymentBody,
  key: paymentKey,
});
assert.equal(replayPayment.body.pagoId, approved.body.pagoId);
assert.equal((await request('pagos', accountPath)).body.saldo, '0.00');
assert.ok(approved.body.notificacionId, 'pago con aviso persistente');
await waitFor(
  'pagos',
  `/api/v1/notificaciones/${approved.body.notificacionId}`,
  (r) => r.status === 200 && r.body.estado === 'ENVIADA',
  'aviso simulado enviado',
);

const paidCancellation = await request(
  'reservas',
  `/api/v1/reservas/${reservation.reservaId}`,
  { method: 'DELETE', key: randomUUID() },
);
assert.equal(
  paidCancellation.status,
  409,
  'reserva pagada requiere gestion manual, sin reembolso automatico',
);
const cancelable = await reserve(dates(offset + 4));
const cancelled = await request(
  'reservas',
  `/api/v1/reservas/${cancelable.reservaId}`,
  { method: 'DELETE', key: randomUUID() },
);
assert.ok([204, 202].includes(cancelled.status));
await waitFor(
  'reservas',
  `/api/v1/reservas/${cancelable.reservaId}`,
  (r) => r.status === 200 && r.body.estado === 'CANCELADA',
  'cancelacion sin pago',
);

console.log(
  `Smoke OK: cuatro APIs, ${gateway ? 'gateway, ' : ''}registro/login, disponibilidad, reserva idempotente, cuenta, pago rechazado/aprobado, aviso persistente y cancelacion.`,
);
