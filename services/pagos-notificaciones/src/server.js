import { loadConfig } from './config.js';
import { createPool } from '../../shared/database.js';
import { createVerifier } from '../../shared/security.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createPool(config.PAGOS_DATABASE_URL);
db.on('error', () =>
  console.error(
    JSON.stringify({
      codigo: 'DB_POOL_ERROR',
      servicio: 'pagos-notificaciones',
    }),
  ),
);
const tokens = await createVerifier(config);
const app = createApp({ db, tokens, config });
const server = app.listen(config.PAGOS_PORT, config.HOST, () =>
  console.log(
    `Pagos/Notificaciones escuchando en ${config.HOST}:${config.PAGOS_PORT}`,
  ),
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
const poll = setInterval(
  () =>
    app.locals
      .processNotifications()
      .catch(() => console.error(JSON.stringify({ codigo: 'AVISOS_ERROR' }))),
  config.NOTIFICATION_POLL_MS,
).unref();
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(poll);
  const timer = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await db.end();
    clearTimeout(timer);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
