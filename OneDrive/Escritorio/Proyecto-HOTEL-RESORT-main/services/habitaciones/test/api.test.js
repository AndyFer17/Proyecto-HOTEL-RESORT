import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { createApp } from '../src/app.js';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrate.js';

const config = {
  SERVICE_TOKEN: 'token-de-servicio-solo-para-pruebas-0123456789',
  BLOQUEO_TTL_SECONDS: 600,
};
const SUITE = '11111111-1111-4111-8111-111111111301'; // 660.00, cap 2
const FAMILIAR = '11111111-1111-4111-8111-111111111202'; // 540.00, cap 4
const logs = [];
const logger = {
  info: (value) => logs.push(value),
  error: (value) => logs.push(value),
};
let db, server, base;

function addDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const D1 = addDays(400);
const D3 = addDays(402);
const D5 = addDays(404);

async function listen(app) {
  const instance = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => instance.once('listening', resolve));
  return instance;
}
function close(instance) {
  return new Promise((resolve, reject) =>
    instance.close((e) => (e ? reject(e) : resolve())),
  );
}
async function request(path, { method = 'GET', body, token, key } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
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
function block(overrides = {}, options = {}) {
  return request('/api/v1/interno/bloqueos', {
    method: 'POST',
    token: config.SERVICE_TOKEN,
    key: options.key ?? randomUUID(),
    body: {
      reservaId: randomUUID(),
      habitacionId: SUITE,
      desde: D1,
      hasta: D3,
      personas: 2,
      ...overrides,
    },
  });
}
const service = (method, path, key = randomUUID()) =>
  request(path, { method, token: config.SERVICE_TOKEN, key });

before(async () => {
  db = process.env.TEST_HABITACIONES_DATABASE_URL
    ? createPool(process.env.TEST_HABITACIONES_DATABASE_URL)
    : new PGlite({ extensions: { btree_gist } });
  await migrate(db);
  server = await listen(createApp({ db, config, logger }));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await close(server);
  await db.end?.();
  await db.close?.();
});

test('health responde OK con persistencia disponible', async () => {
  const live = await request('/health/live');
  const ready = await request('/health/ready');
  assert.equal(live.status, 200);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.servicio, 'habitaciones');
});

test('disponibilidad lista habitaciones y filtra por personas', async () => {
  const all = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${D1}&hasta=${D3}&personas=2`,
  );
  assert.equal(all.status, 200);
  assert.equal(all.body.habitaciones.length, 6);
  const big = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${D1}&hasta=${D3}&personas=4`,
  );
  assert.deepEqual(big.body.habitaciones.map((h) => h.numero).sort(), [
    '202',
    '302',
  ]);
  const room = all.body.habitaciones.find((h) => h.numero === '301');
  assert.equal(room.tarifaNoche, '660.00');
  assert.equal(room.moneda, 'PEN');
});

test('disponibilidad valida formato y reglas de fechas', async () => {
  const bad = await request(
    '/api/v1/habitaciones/disponibilidad?desde=hoy&hasta=2030-01-01&personas=2',
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.body.codigo, 'DATOS_INVALIDOS');
  const extra = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${D1}&hasta=${D3}&personas=2&x=1`,
  );
  assert.equal(extra.status, 400);
  const order = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${D3}&hasta=${D1}&personas=2`,
  );
  assert.equal(order.status, 422);
  assert.equal(order.body.codigo, 'RANGO_INVALIDO');
  const past = await request(
    '/api/v1/habitaciones/disponibilidad?desde=2020-01-01&hasta=2020-01-03&personas=2',
  );
  assert.equal(past.status, 422);
  assert.equal(past.body.codigo, 'FECHA_PASADA');
  const long = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${D1}&hasta=${addDays(440)}&personas=2`,
  );
  assert.equal(long.status, 422);
  assert.equal(long.body.codigo, 'ESTADIA_EXCESIVA');
});

test('consultar habitacion: 200, 404 y 400', async () => {
  const ok = await request(`/api/v1/habitaciones/${SUITE}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.numero, '301');
  const missing = await request(`/api/v1/habitaciones/${randomUUID()}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.codigo, 'HABITACION_NO_ENCONTRADA');
  const invalid = await request('/api/v1/habitaciones/abc');
  assert.equal(invalid.status, 400);
});

test('endpoints internos exigen identidad de servicio e Idempotency-Key', async () => {
  const body = {
    reservaId: randomUUID(),
    habitacionId: SUITE,
    desde: D1,
    hasta: D3,
    personas: 2,
  };
  const none = await request('/api/v1/interno/bloqueos', {
    method: 'POST',
    body,
    key: randomUUID(),
  });
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer');
  const wrong = await request('/api/v1/interno/bloqueos', {
    method: 'POST',
    body,
    token: 'x'.repeat(40),
    key: randomUUID(),
  });
  assert.equal(wrong.status, 403);
  const nokey = await request('/api/v1/interno/bloqueos', {
    method: 'POST',
    body,
    token: config.SERVICE_TOKEN,
  });
  assert.equal(nokey.status, 400);
  assert.equal(nokey.body.codigo, 'IDEMPOTENCY_KEY_INVALIDA');
  const strict = await block({ extra: true });
  assert.equal(strict.status, 400);
});

test('bloqueo exitoso calcula total y oculta la habitacion', async () => {
  const reservaId = randomUUID();
  const res = await block({ reservaId, desde: D3, hasta: D5 });
  assert.equal(res.status, 201);
  assert.equal(res.body.total, '1320.00');
  assert.equal(res.body.moneda, 'PEN');
  assert.ok(new Date(res.body.venceEn) > new Date());
  const avail = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${D3}&hasta=${D5}&personas=2`,
  );
  assert.equal(
    avail.body.habitaciones.some((h) => h.habitacionId === SUITE),
    false,
  );
});

test('misma Idempotency-Key repite respuesta; otro cuerpo da 409', async () => {
  const key = randomUUID();
  const input = { reservaId: randomUUID(), habitacionId: FAMILIAR };
  const first = await block(input, { key });
  const again = await block(input, { key });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.body.bloqueoId, first.body.bloqueoId);
  const other = await block({ ...input, personas: 3 }, { key });
  assert.equal(other.status, 409);
  assert.equal(other.body.codigo, 'IDEMPOTENCIA_CONFLICTO');
});

test('solape de fechas da 409 y fechas contiguas se permiten', async () => {
  const room = '11111111-1111-4111-8111-111111111101';
  const a = await block({
    habitacionId: room,
    desde: addDays(500),
    hasta: addDays(503),
  });
  assert.equal(a.status, 201);
  const overlap = await block({
    habitacionId: room,
    desde: addDays(502),
    hasta: addDays(505),
  });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.codigo, 'HABITACION_NO_DISPONIBLE');
  const next = await block({
    habitacionId: room,
    desde: addDays(503),
    hasta: addDays(505),
  });
  assert.equal(next.status, 201);
});

test('solicitudes simultaneas: solo una gana la habitacion', async () => {
  const room = '11111111-1111-4111-8111-111111111102';
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      block({ habitacionId: room, desde: addDays(600), hasta: addDays(602) }),
    ),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
});

test('una reserva no puede tener dos bloqueos activos', async () => {
  const reservaId = randomUUID();
  const first = await block({
    reservaId,
    desde: addDays(700),
    hasta: addDays(702),
  });
  assert.equal(first.status, 201);
  const second = await block({
    reservaId,
    habitacionId: FAMILIAR,
    desde: addDays(700),
    hasta: addDays(702),
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.codigo, 'RESERVA_CON_BLOQUEO_ACTIVO');
});

test('capacidad excedida y habitacion inexistente', async () => {
  const cap = await block({
    personas: 3,
    desde: addDays(800),
    hasta: addDays(801),
  });
  assert.equal(cap.status, 422);
  assert.equal(cap.body.codigo, 'CAPACIDAD_EXCEDIDA');
  const missing = await block({
    habitacionId: randomUUID(),
    desde: addDays(800),
    hasta: addDays(801),
  });
  assert.equal(missing.status, 404);
});

test('confirmar bloqueo es idempotente; inexistente da 404', async () => {
  const res = await block({ desde: addDays(900), hasta: addDays(902) });
  const path = `/api/v1/interno/bloqueos/${res.body.bloqueoId}/confirmacion`;
  const ok = await service('PUT', path);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.estado, 'CONFIRMADO');
  const again = await service('PUT', path);
  assert.equal(again.status, 200);
  const missing = await service(
    'PUT',
    `/api/v1/interno/bloqueos/${randomUUID()}/confirmacion`,
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.codigo, 'BLOQUEO_NO_ENCONTRADO');
});

test('liberar devuelve el inventario y es idempotente', async () => {
  const desde = addDays(1000);
  const hasta = addDays(1002);
  const res = await block({ desde, hasta });
  const path = `/api/v1/interno/bloqueos/${res.body.bloqueoId}`;
  assert.equal((await service('DELETE', path)).status, 204);
  assert.equal((await service('DELETE', path)).status, 204);
  const avail = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${desde}&hasta=${hasta}&personas=2`,
  );
  assert.equal(
    avail.body.habitaciones.some((h) => h.habitacionId === SUITE),
    true,
  );
  const missing = await service(
    'DELETE',
    `/api/v1/interno/bloqueos/${randomUUID()}`,
  );
  assert.equal(missing.status, 404);
  const confirm = await service('PUT', `${path}/confirmacion`);
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.codigo, 'BLOQUEO_NO_CONFIRMABLE');
});

test('un bloqueo vencido libera la habitacion y no se puede confirmar', async () => {
  const desde = addDays(1100);
  const hasta = addDays(1102);
  const old = await block({ desde, hasta });
  await db.query(
    `UPDATE habitaciones.bloqueos
     SET vence_en = now() - interval '1 minute' WHERE bloqueo_id = $1`,
    [old.body.bloqueoId],
  );
  const avail = await request(
    `/api/v1/habitaciones/disponibilidad?desde=${desde}&hasta=${hasta}&personas=2`,
  );
  assert.equal(
    avail.body.habitaciones.some((h) => h.habitacionId === SUITE),
    true,
  );
  const fresh = await block({ desde, hasta });
  assert.equal(fresh.status, 201);
  const late = await service(
    'PUT',
    `/api/v1/interno/bloqueos/${old.body.bloqueoId}/confirmacion`,
  );
  assert.equal(late.status, 409);
});

test('errores genericos: JSON invalido, ruta inexistente, traceId', async () => {
  const response = await fetch(`${base}/api/v1/interno/bloqueos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.SERVICE_TOKEN}`,
    },
    body: '{malo',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).codigo, 'JSON_INVALIDO');
  const missing = await request('/api/v1/nada');
  assert.equal(missing.status, 404);
  assert.match(missing.body.traceId, /^[0-9a-f-]{36}$/);
  assert.ok(logs.length > 0);
});