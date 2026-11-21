import { createPool } from './database.js';
import { migrateFiles } from '../../shared/database.js';

const dir = new URL('../migrations/', import.meta.url);

export async function migrate(db) {
  return migrateFiles(db, dir);
}

if (
  process.argv[1] &&
  import.meta.url ===
    (await import('node:url')).pathToFileURL(process.argv[1]).href
) {
  if (!process.env.HABITACIONES_DATABASE_URL)
    throw new Error('Falta HABITACIONES_DATABASE_URL.');
  const db = createPool(process.env.HABITACIONES_DATABASE_URL);
  try {
    const total = await migrate(db);
    console.log(`Migraciones de Habitaciones aplicadas: ${total}.`);
  } catch {
    console.error('No se pudo migrar. Revisa conexion y permisos.');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
