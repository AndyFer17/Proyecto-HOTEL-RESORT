import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const input = {
  nombre: 'Huésped Smoke',
  email: `smoke-${randomUUID()}@example.com`,
  password: 'Prueba-temporal-2026!',
};
async function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
const ready = await fetch(`${base}/health/ready`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(ready.status, 200);
const registered = await post('/api/v1/clientes', input);
assert.equal(registered.status, 201);
const client = await registered.json();
const login = await post('/api/v1/auth/login', {
  email: input.email,
  password: input.password,
});
assert.equal(login.status, 200);
const { accessToken } = await login.json();
const profile = await fetch(`${base}/api/v1/clientes/${client.clienteId}`, {
  headers: { Authorization: `Bearer ${accessToken}` },
  signal: AbortSignal.timeout(10000),
});
assert.equal(profile.status, 200);
assert.equal((await profile.json()).email, input.email);
console.log(
  'Smoke OK: readiness, registro, login y perfil sobre el servidor activo.',
);
