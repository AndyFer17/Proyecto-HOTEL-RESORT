import pg from 'pg';

const services = {
  clientes: { prefix: 'CLIENTES', schema: 'clientes' },
  habitaciones: { prefix: 'HABITACIONES', schema: 'habitaciones' },
  reservas: { prefix: 'RESERVAS', schema: 'reservas' },
  'pagos-notificaciones': { prefix: 'PAGOS', schema: 'pagos' },
};
const service = process.argv[2];
const spec = services[service];
if (!spec) throw new Error('Servicio de migracion no reconocido.');
const connectionString = process.env[`${spec.prefix}_MIGRATION_DATABASE_URL`];
const runtimePassword = process.env[`${spec.prefix}_APP_PASSWORD`];
if (!connectionString || !runtimePassword || runtimePassword.length < 32)
  throw new Error('Faltan credenciales separadas de migracion y aplicacion.');

const db = new pg.Pool({ connectionString, max: 1 });
const role = `${spec.schema}_app`;
// Todos los identificadores proceden de la lista fija anterior. Los valores
// configurables se convierten en literales mediante PostgreSQL format().
async function statement(template, values) {
  const { rows } = await db.query(
    `SELECT format($1, ${values.map((_, i) => `$${i + 2}::text`).join(', ')}) AS sql`,
    [template, ...values],
  );
  await db.query(rows[0].sql);
}
try {
  const { migrate } = await import(`../services/${service}/src/migrate.js`);
  await migrate(db);
  const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    role,
  ]);
  await statement(
    `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`,
    [role, runtimePassword],
  );
  const database = (await db.query('SELECT current_database() AS name')).rows[0]
    .name;
  await statement('REVOKE ALL ON DATABASE %I FROM PUBLIC', [database]);
  await statement('GRANT CONNECT ON DATABASE %I TO %I', [database, role]);
  await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await statement('GRANT USAGE ON SCHEMA %I TO %I', [spec.schema, role]);
  const tables = await db.query(
    'SELECT tablename FROM pg_tables WHERE schemaname = $1',
    [spec.schema],
  );
  for (const { tablename } of tables.rows) {
    await statement('REVOKE ALL ON TABLE %I.%I FROM %I', [
      spec.schema,
      tablename,
      role,
    ]);
    await statement(
      tablename === 'schema_migrations'
        ? 'GRANT SELECT ON TABLE %I.%I TO %I'
        : 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
      [spec.schema, tablename, role],
    );
  }
  await statement('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', [
    spec.schema,
    role,
  ]);
  console.log(`Migraciones y permisos de ejecucion aplicados: ${service}.`);
} catch {
  console.error(
    `No se pudo migrar ${service}; revisar conexion y permisos del propietario.`,
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
