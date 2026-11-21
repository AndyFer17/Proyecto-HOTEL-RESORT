import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { importPKCS8, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { createTokens } from '../src/security/tokens.js';
import { hashPassword, verifyPassword } from '../src/security/passwords.js';
import { createPool } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

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
const logs = [];
const logger = {
  info: (value) => logs.push(value),
  error: (value) => logs.push(value),
};
let db, tokens, server, base;
const suffix = randomUUID();
const password = 'Ejemplo-academico-2026!';
const input = {
  nombre: 'Ana Prueba',
  email: `ana-${suffix}@example.com`,
  password,
};
let client, token;

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
async function request(
  path,
  { method = 'GET', body, bearer, headers = {} } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
}

before(async () => {
  db = process.env.TEST_DATABASE_URL
    ? createPool(process.env.TEST_DATABASE_URL)
    : new PGlite();
  await migrate(db);
  tokens = await createTokens(config);
  server = await listen(
    await createApp({ db, tokens, config, logger, authLimit: 100 }),
  );
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await close(server);
  if (db) await (db.end ? db.end() : db.close());
});

test('migración repetible y readiness comprueba tabla real', async () => {
  await migrate(db);
  assert.equal((await request('/health/ready')).status, 200);
  assert.equal((await request('/health/live')).status, 200);
});
test('registro persistido, normalización y ausencia de secretos en respuesta', async () => {
  const result = await request('/api/v1/clientes', {
    method: 'POST',
    body: { ...input, email: `  ${input.email.toUpperCase()}  ` },
  });
  assert.equal(result.status, 201);
  client = result.body;
  assert.equal(client.email, input.email);
  assert.equal(client.rol, 'HUESPED');
  assert.equal(
    result.headers.get('location'),
    `/api/v1/clientes/${client.clienteId}`,
  );
  assert.equal(result.headers.get('x-powered-by'), null);
  assert.ok(result.headers.get('x-content-type-options'));
  assert.ok(!JSON.stringify(client).includes('password'));
  const stored = (
    await db.query(
      'SELECT password_hash FROM clientes.huespedes WHERE cliente_id=$1',
      [client.clienteId],
    )
  ).rows[0];
  assert.notEqual(stored.password_hash, password);
  assert.equal(await verifyPassword(password, stored.password_hash), true);
});
test('correo duplicado y concurrencia protegidos por restricción UNIQUE', async () => {
  const duplicate = await request('/api/v1/clientes', {
    method: 'POST',
    body: input,
  });
  assert.equal(duplicate.status, 409);
  const concurrent = { ...input, email: `parallel-${suffix}@example.com` };
  const results = await Promise.all(
    [1, 2].map(() =>
      request('/api/v1/clientes', { method: 'POST', body: concurrent }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});
test('rechaza campos inválidos, contraseñas cortas e intento de asignar rol', async () => {
  for (const body of [
    { ...input, email: 'incorrecto' },
    { ...input, password: '123' },
    { ...input, rol: 'ADMIN' },
    { ...input, nombre: ' ' },
  ]) {
    const result = await request('/api/v1/clientes', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.body.codigo, 'DATOS_INVALIDOS');
    assert.ok(result.body.traceId);
    assert.ok(!JSON.stringify(result.body).includes(password));
  }
});
test('login válido entrega JWT con expiración y perfil propio', async () => {
  const login = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: input.email, password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.expiresIn, 900);
  token = login.body.accessToken;
  const identity = await tokens.verify(token);
  assert.equal(identity.sub, client.clienteId);
  assert.equal(identity.exp - identity.iat, 900);
  const result = await request(`/api/v1/clientes/${client.clienteId}`, {
    bearer: token,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.email, input.email);
});
test('login inexistente y contraseña equivocada tienen mismo error', async () => {
  const a = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: input.email, password: 'incorrecta' },
  });
  const b = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'incorrecta' },
  });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.codigo, b.body.codigo);
  assert.equal(a.body.mensaje, b.body.mensaje);
});
test('rechaza ausencia, alteración, expiración y audiencia incorrecta del token', async () => {
  const key = await importPKCS8(pair.privateKey, 'RS256');
  const sign = (audience, expiration) =>
    new SignJWT({ rol: 'HUESPED' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(client.clienteId)
      .setIssuer(config.JWT_ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(expiration)
      .sign(key);
  const expired = await sign(
    config.JWT_AUDIENCE,
    Math.floor(Date.now() / 1000) - 10,
  );
  const otherAudience = await sign('otro-sistema', '15m');
  for (const bearer of [
    undefined,
    'invalido',
    `${token.slice(0, -10)}aaaaaaaaaa`,
    expired,
    otherAudience,
  ]) {
    assert.equal(
      (await request(`/api/v1/clientes/${client.clienteId}`, { bearer }))
        .status,
      401,
    );
  }
});
test('un huésped no consulta perfiles ajenos; UUID inválido da 400', async () => {
  assert.equal(
    (await request(`/api/v1/clientes/${randomUUID()}`, { bearer: token }))
      .status,
    403,
  );
  assert.equal(
    (await request('/api/v1/clientes/no-uuid', { bearer: token })).status,
    400,
  );
  const missing = await tokens.issue({
    clienteId: randomUUID(),
    rol: 'HUESPED',
  });
  const id = (await tokens.verify(missing)).sub;
  assert.equal(
    (await request(`/api/v1/clientes/${id}`, { bearer: missing })).status,
    404,
  );
});
test('JWKS publica solamente la clave pública', async () => {
  const result = await request('/.well-known/jwks.json');
  assert.equal(result.status, 200);
  assert.equal(result.body.keys[0].alg, 'RS256');
  assert.ok(result.body.keys[0].n);
  assert.equal(result.body.keys[0].d, undefined);
});
test('JSON roto, tamaño, content-type y ruta desconocida controlados', async () => {
  const malformed = await fetch(`${base}/api/v1/clientes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  const tooLarge = await request('/api/v1/clientes', {
    method: 'POST',
    body: { nombre: 'x'.repeat(18000) },
  });
  assert.equal(tooLarge.status, 413);
  const content = await fetch(`${base}/api/v1/clientes`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'texto',
  });
  assert.equal(content.status, 415);
  assert.equal((await request('/no-existe')).status, 404);
});
test('rate limiting devuelve 429 y Retry-After', async () => {
  const limited = await listen(
    await createApp({ db, tokens, config, logger, authLimit: 1 }),
  );
  try {
    const url = `http://127.0.0.1:${limited.address().port}/api/v1/auth/login`;
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    };
    await fetch(url, options);
    const response = await fetch(url, options);
    assert.equal(response.status, 429);
    assert.ok(response.headers.get('retry-after'));
  } finally {
    await close(limited);
  }
});
test('fallo de base de datos da readiness 503 y error público sin detalles internos', async () => {
  const broken = {
    query: async () => {
      throw new Error('password=secreto-base');
    },
  };
  const instance = await listen(
    await createApp({ db: broken, tokens, config, logger }),
  );
  try {
    const url = `http://127.0.0.1:${instance.address().port}`;
    assert.equal((await fetch(`${url}/health/ready`)).status, 503);
    const result = await fetch(`${url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input.email, password }),
    });
    assert.equal(result.status, 500);
    assert.ok(!(await result.text()).includes('secreto-base'));
  } finally {
    await close(instance);
  }
});
test('hashes con sal distinta y comparación negativa', async () => {
  const a = await hashPassword(password),
    b = await hashPassword(password);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('otra-clave', a), false);
  assert.equal(await verifyPassword(password, 'malformado'), false);
});
test('configuración falla sin secretos y no expone valores', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'secreto' }),
    /Configuración inválida/,
  );
  try {
    loadConfig({ DATABASE_URL: 'no-imprimir-esto' });
  } catch (error) {
    assert.ok(!error.message.includes('no-imprimir-esto'));
  }
});
test('persistencia sobre disco se conserva al reabrir PostgreSQL embebido', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resort-clientes-'));
  let embedded;
  try {
    embedded = new PGlite(directory);
    await migrate(embedded);
    const id = randomUUID();
    await embedded.query(
      'INSERT INTO clientes.huespedes (cliente_id,nombre,email,password_hash) VALUES ($1,$2,$3,$4)',
      [
        id,
        'Persistencia',
        'persistencia@example.com',
        await hashPassword(password),
      ],
    );
    await embedded.close();
    embedded = new PGlite(directory);
    assert.equal(
      (await embedded.query('SELECT cliente_id FROM clientes.huespedes'))
        .rows[0].cliente_id,
      id,
    );
  } finally {
    if (embedded) await embedded.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('logs no contienen contraseñas, tokens, correo ni detalles de conexión', () => {
  const all = logs.join('\n');
  for (const secret of [password, token, input.email, 'secreto-base'])
    assert.ok(!all.includes(secret));
  assert.ok(all.includes('traceId'));
});
