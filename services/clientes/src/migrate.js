import { createPool } from './database.js';
import { migrateFiles } from '../../shared/database.js';

export async function migrate(db) {
  return migrateFiles(db, new URL('../migrations/', import.meta.url));
}

if (
  process.argv[1] &&
  import.meta.url ===
    (await import('node:url')).pathToFileURL(process.argv[1]).href
) {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL.');
  const db = createPool(process.env.DATABASE_URL);
  try {
    await migrate(db);
    console.log('Migración 001 aplicada.');
  } catch {
    console.error(
      'No se pudo aplicar la migración. Revisa conexión y permisos.',
    );
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
