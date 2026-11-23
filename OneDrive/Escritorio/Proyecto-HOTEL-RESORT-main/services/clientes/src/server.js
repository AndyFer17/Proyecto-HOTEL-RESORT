import { loadConfig } from './config.js';
import { createPool } from './database.js';
import { createTokens } from './security/tokens.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
db.on('error', () =>
  console.error(JSON.stringify({ codigo: 'DB_POOL_ERROR' })),
);
const tokens = await createTokens(config);
const app = await createApp({ db, tokens, config });
const server = app.listen(config.PORT, config.HOST, () =>
  console.log(`Clientes escuchando en ${config.HOST}:${config.PORT}`),
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
