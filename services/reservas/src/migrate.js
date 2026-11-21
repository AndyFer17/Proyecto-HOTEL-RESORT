import { pathToFileURL } from 'node:url';
import { createPool, migrateFiles } from '../../shared/database.js';

export async function migrate(db) {
  return migrateFiles(db, new URL('../migrations/', import.meta.url));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.env.RESERVAS_DATABASE_URL)
    throw new Error('Falta RESERVAS_DATABASE_URL.');
  const db = createPool(process.env.RESERVAS_DATABASE_URL);
  try {
    await migrate(db);
    console.log('Migraciones de Reservas aplicadas.');
  } catch {
    console.error('No se pudo migrar Reservas. Revisa conexion y permisos.');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
