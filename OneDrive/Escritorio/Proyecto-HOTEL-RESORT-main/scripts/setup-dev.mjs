import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const password = randomBytes(24).toString('hex');
const env = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '3001',
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgresql://clientes:${password}@127.0.0.1:5433/clientes`,
  JWT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
  JWT_PUBLIC_KEY_BASE64: Buffer.from(publicKey).toString('base64'),
  JWT_ISSUER: 'resort-clientes',
  JWT_AUDIENCE: 'resort-api',
  JWT_TTL_SECONDS: '900',
};
try {
  writeFileSync(
    '.env',
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    '.env creado. Contiene secretos locales: no compartir ni subir a Git.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('.env ya existe: se conserva sin cambios.');
  process.exitCode = 1;
}
