import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const force = process.argv.includes('--force');
if (existsSync('.env') && !force) {
  console.log(
    '.env ya existe: se conserva sin cambios. Para regenerarlo usa --force explicitamente.',
  );
} else {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const env = {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3001',
    HABITACIONES_PORT: '3002',
    RESERVAS_PORT: '3003',
    PAGOS_PORT: '3004',
    JWT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
    JWT_PUBLIC_KEY_BASE64: Buffer.from(publicKey).toString('base64'),
    JWT_ISSUER: 'resort-clientes',
    JWT_AUDIENCE: 'resort-api',
    JWT_TTL_SECONDS: '900',
    SERVICE_TOKEN: randomBytes(32).toString('hex'),
    BLOQUEO_TTL_SECONDS: '600',
    CLIENTES_URL: 'http://127.0.0.1:3001',
    HABITACIONES_URL: 'http://127.0.0.1:3002',
    RESERVAS_URL: 'http://127.0.0.1:3003',
    PAGOS_URL: 'http://127.0.0.1:3004',
    ALLOW_SIMULATED_PROVIDERS: 'true',
    NOTIFICATION_POLL_MS: '1000',
    DEPENDENCY_TIMEOUT_MS: '3000',
  };
  for (const [schema, port] of [
    ['clientes', 5433],
    ['habitaciones', 5434],
    ['reservas', 5435],
    ['pagos', 5436],
  ]) {
    const prefix = schema.toUpperCase();
    const ownerPassword = randomBytes(24).toString('hex');
    const appPassword = randomBytes(24).toString('hex');
    env[`${prefix}_OWNER_PASSWORD`] = ownerPassword;
    env[`${prefix}_APP_PASSWORD`] = appPassword;
    env[`${prefix}_MIGRATION_DATABASE_URL`] =
      `postgresql://${schema}_owner:${ownerPassword}@127.0.0.1:${port}/${schema}`;
    env[schema === 'clientes' ? 'DATABASE_URL' : `${prefix}_DATABASE_URL`] =
      `postgresql://${schema}_app:${appPassword}@127.0.0.1:${port}/${schema}`;
  }
  writeFileSync(
    '.env',
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { flag: force ? 'w' : 'wx', mode: 0o600 },
  );
  console.log(
    '.env creado con credenciales locales separadas y proveedores simulados. No compartir ni subir a Git.',
  );
  if (force)
    console.log(
      'Se regeneraron credenciales. Los volumenes PostgreSQL existentes conservan sus contraseñas anteriores.',
    );
}
