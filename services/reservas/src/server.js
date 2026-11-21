import { loadConfig } from './config.js';
import { createPool } from '../../shared/database.js';
import { createVerifier } from '../../shared/security.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createPool(config.RESERVAS_DATABASE_URL);
db.on('error', () =>
  console.error(JSON.stringify({ codigo: 'DB_POOL_ERROR' })),
);
const tokens = await createVerifier(config);
const app = createApp({ db, tokens, config });
const server = app.listen(config.RESERVAS_PORT, config.HOST, () =>
  console.log(`Reservas escuchando en ${config.HOST}:${config.RESERVAS_PORT}`),
);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
app.locals.coordinator.start();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 15000).unref();
  await app.locals.coordinator.stop();
  server.close(async () => {
    await db.end();
    clearTimeout(timer);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
