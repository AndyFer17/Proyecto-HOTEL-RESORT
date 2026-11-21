import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function createPool(connectionString) {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
}

export async function withTransaction(db, fn) {
  if (typeof db.connect !== 'function') return db.transaction((tx) => fn(tx));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateFiles(db, directory) {
  const files = (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  await db.query(
    'CREATE TABLE IF NOT EXISTS public.soa_migrations (archivo text PRIMARY KEY, sha256 char(64) NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())',
  );
  let applied = 0;
  for (const name of files) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    await withTransaction(db, async (tx) => {
      const existing = (
        await tx.query(
          'SELECT sha256 FROM public.soa_migrations WHERE archivo=$1',
          [name],
        )
      ).rows[0];
      if (existing) {
        if (existing.sha256 !== digest)
          throw new Error(`La migración ya aplicada cambió: ${name}`);
        return;
      }
      // Los archivos existentes incluyen BEGIN/COMMIT; la versión se registra en la misma transacción.
      const body = sql
        .replace(/^\s*BEGIN\s*;/i, '')
        .replace(/COMMIT\s*;\s*$/i, '');
      if (typeof tx.exec === 'function') await tx.exec(body);
      else await tx.query(body);
      await tx.query(
        'INSERT INTO public.soa_migrations (archivo,sha256) VALUES ($1,$2)',
        [name, digest],
      );
      applied += 1;
    });
  }
  return applied;
}
