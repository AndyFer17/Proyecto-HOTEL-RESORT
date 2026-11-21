import { pathToFileURL } from 'node:url';
import { createPool, migrateFiles } from '../../shared/database.js';

const dir = new URL('../migrations/', import.meta.url);
export async function migrate(db) {
  return migrateFiles(db, dir);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.env.PAGOS_DATABASE_URL)
    throw new Error('Falta PAGOS_DATABASE_URL.');
  const db = createPool(process.env.PAGOS_DATABASE_URL);
  try {
    console.log(`Migraciones Pagos: ${await migrate(db)}.`);
  } catch {
    console.error('No se pudo migrar Pagos.');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
