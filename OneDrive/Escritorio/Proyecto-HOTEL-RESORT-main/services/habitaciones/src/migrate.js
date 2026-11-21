import { readdir, readFile } from 'node:fs/promises';
import { createPool } from './database.js';

const dir = new URL('../migrations/', import.meta.url);

export async function migrate(db) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    if (typeof db.connect === 'function') {
      // Una unica conexion para mantener BEGIN/COMMIT en la misma sesion.
      const client = await db.connect();
      try {
        await client.query(sql);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      await db.exec(sql);
    }
  }
  return files.length;
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