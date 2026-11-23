import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';

export async function migrate(db) {
  const sql = await readFile(
    new URL('../migrations/001_create_clientes.sql', import.meta.url),
    'utf8',
  );
  // Usar una única conexión para mantener BEGIN/COMMIT en la misma sesión.
  if (typeof db.connect === 'function') {
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
