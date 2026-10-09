import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';

function map(row) {
  if (!row) return null;
  return {
    clienteId: row.cliente_id,
    nombre: row.nombre,
    email: row.email,
    telefono: row.telefono,
    rol: row.rol,
    creadoEn: row.creado_en,
    passwordHash: row.password_hash,
  };
}

export function createClientesRepository(db) {
  return {
    async create({ nombre, email, telefono, passwordHash }) {
      try {
        const result = await db.query(
          `INSERT INTO clientes.huespedes
          (cliente_id, nombre, email, telefono, password_hash)
          VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [randomUUID(), nombre, email, telefono ?? null, passwordHash],
        );
        return map(result.rows[0]);
      } catch (error) {
        if (error.code === '23505')
          throw new AppError(
            409,
            'EMAIL_DUPLICADO',
            'El correo ya está registrado.',
          );
        throw error;
      }
    },
    async findByEmail(email) {
      return map(
        (
          await db.query('SELECT * FROM clientes.huespedes WHERE email = $1', [
            email,
          ])
        ).rows[0],
      );
    },
    async findById(id) {
      return map(
        (
          await db.query(
            'SELECT * FROM clientes.huespedes WHERE cliente_id = $1',
            [id],
          )
        ).rows[0],
      );
    },
    async ready() {
      await db.query('SELECT cliente_id FROM clientes.huespedes LIMIT 1');
    },
  };
}
