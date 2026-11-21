import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SignJWT, importPKCS8 } from 'jose';
import { createVerifier, serviceAuth } from '../../services/shared/security.js';
import { createHttpApp, finishApp } from '../../services/shared/http.js';
import { callService } from '../../services/shared/client.js';
import { parseMoney, formatMoney } from '../../services/shared/money.js';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('verificación común rechaza algoritmo, audiencia, rol, tipo y sujeto no autorizados', async () => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = await importPKCS8(pair.privateKey, 'RS256');
  const verifier = await createVerifier({
    JWT_PUBLIC_KEY_BASE64: Buffer.from(pair.publicKey).toString('base64'),
  });
  const sign = ({
    rol = 'HUESPED',
    sub = randomUUID(),
    aud = 'resort-api',
    typ = 'JWT',
    expires = '15m',
  } = {}) =>
    new SignJWT({ rol })
      .setProtectedHeader({ alg: 'RS256', typ })
      .setSubject(sub)
      .setAudience(aud)
      .setIssuer('resort-clientes')
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(expires)
      .sign(key);
  assert.equal((await verifier.verify(await sign())).rol, 'HUESPED');
  for (const changes of [
    { rol: 'ADMIN' },
    { sub: 'no-uuid' },
    { aud: 'otro-sistema' },
    { typ: 'otro' },
    { expires: '-1s' },
  ])
    await assert.rejects(verifier.verify(await sign(changes)));
  const hs = await new SignJWT({ rol: 'HUESPED' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(randomUUID())
    .setAudience('resort-api')
    .setIssuer('resort-clientes')
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(pair.publicKey));
  await assert.rejects(verifier.verify(hs));
});

test('middleware oculta errores y limita intentos sin confiar en X-Forwarded-For', async () => {
  const logs = [];
  const logger = { info: (s) => logs.push(s), error: (s) => logs.push(s) };
  const app = createHttpApp({ service: 'test', logger, limit: 3 });
  app.get('/secreto', () => {
    throw new Error('credencial-interna-no-publicar');
  });
  app.get(
    '/interno',
    serviceAuth('token-servicio-exclusivo-de-prueba-0123456789'),
    (req, res) => res.json({ ok: true }),
  );
  finishApp(app, { logger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/secreto`);
    assert.equal(first.status, 500);
    const error = await first.json();
    assert.equal(error.codigo, 'ERROR_INTERNO');
    assert.equal(JSON.stringify(error).includes('credencial-interna'), false);
    assert.equal(first.headers.get('x-powered-by'), null);
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/interno`)).status, 401);
    await fetch(`${base}/secreto`);
    const limited = await fetch(`${base}/secreto`);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal(
      logs.join('').includes('credencial-interna-no-publicar'),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cliente interservicios no sigue redirecciones con credenciales y limita respuestas', async () => {
  let leaked = false;
  const destination = await serve((req, res) => {
    leaked = Boolean(req.headers.authorization);
    res.end('{}');
  });
  const source = await serve((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: destination.url });
      return res.end();
    }
    if (req.url === '/large') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: 'x'.repeat(70000) }));
    }
    if (req.url === '/auth') {
      res.writeHead(403);
      return res.end(
        JSON.stringify({ codigo: 'INTERNO', mensaje: 'secreto del backend' }),
      );
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        key: req.headers['idempotency-key'],
        trace: req.headers['x-request-id'],
      }),
    );
  });
  try {
    const key = randomUUID(),
      traceId = randomUUID();
    const result = await callService(source.url, '/ok', {
      method: 'POST',
      key,
      traceId,
      body: { ok: true },
      token: 'interno-no-filtrar',
    });
    assert.deepEqual(result.body, { key, trace: traceId });
    await assert.rejects(
      callService(source.url, '/redirect', { token: 'interno-no-filtrar' }),
      (e) => e.status === 503,
    );
    await assert.rejects(
      callService(source.url, '/large'),
      (e) => e.status === 503,
    );
    await assert.rejects(
      callService(source.url, '/auth'),
      (e) => e.status === 503 && !e.message.includes('secreto'),
    );
    assert.equal(leaked, false);
  } finally {
    await source.close();
    await destination.close();
  }
});

test('dinero exacto sin coma flotante y validación del límite de numeric(12,2)', () => {
  assert.equal(formatMoney(parseMoney('0.10') + parseMoney('0.20')), '0.30');
  assert.equal(formatMoney(parseMoney('9999999999.99')), '9999999999.99');
  for (const value of ['1e3', '-1.00', '0.001', '01.00', '10000000000.00', 1.1])
    assert.throws(() => parseMoney(value));
});
