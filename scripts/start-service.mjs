import { spawn } from 'node:child_process';

const common = [
  'NODE_ENV',
  'HOST',
  'JWT_PUBLIC_KEY_BASE64',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
];
const serviceVars = {
  clientes: [
    'PORT',
    'DATABASE_URL',
    'JWT_PRIVATE_KEY_BASE64',
    'JWT_TTL_SECONDS',
  ],
  habitaciones: [
    'SERVICE_TOKEN',
    'HABITACIONES_PORT',
    'HABITACIONES_DATABASE_URL',
    'BLOQUEO_TTL_SECONDS',
  ],
  reservas: [
    'SERVICE_TOKEN',
    'RESERVAS_PORT',
    'RESERVAS_DATABASE_URL',
    'CLIENTES_URL',
    'HABITACIONES_URL',
    'PAGOS_URL',
    'DEPENDENCY_TIMEOUT_MS',
  ],
  'pagos-notificaciones': [
    'SERVICE_TOKEN',
    'PAGOS_PORT',
    'PAGOS_DATABASE_URL',
    'RESERVAS_URL',
    'ALLOW_SIMULATED_PROVIDERS',
    'NOTIFICATION_POLL_MS',
  ],
};
const service = process.argv[2];
if (!serviceVars[service]) throw new Error('Servicio no reconocido.');
const keys = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'TZ',
  ...common,
  ...serviceVars[service],
];
const env = Object.fromEntries(
  keys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
// Solo Clientes recibe la clave de firma. Ningun proceso recibe contraseñas
// de propietarios ni URLs de persistencia de otros dominios.
if (service !== 'clientes') delete env.JWT_PRIVATE_KEY_BASE64;
const child = spawn(
  process.execPath,
  [
    ...(process.argv.includes('--watch') ? ['--watch'] : []),
    `services/${service}/src/server.js`,
  ],
  { env, stdio: 'inherit' },
);
child.on('error', () => {
  console.error(`No se pudo iniciar ${service}.`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
