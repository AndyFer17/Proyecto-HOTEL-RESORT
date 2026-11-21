import { loadConfig } from './config.js';
import { createPool } from './database.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createPool(config.HABITACIONES_DATABASE_URL);
db.on('error', () =>
  console.error(JSON.stringify({ codigo: 'DB_POOL_ERROR' })),
);
const app = createApp({ db, config });
const server = app.listen(config.HABITACIONES_PORT, config.HOST, () =>
  console.log(
    `Habitaciones escuchando en ${config.HOST}:${config.HABITACIONES_PORT}`,
  ),
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await db.end();
    clearTimeout(timer);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
