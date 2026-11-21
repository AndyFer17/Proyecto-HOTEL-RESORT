import { createHash } from 'node:crypto';
import { withTransaction } from '../database.js';
import { AppError } from '../errors.js';

// La inserción única serializa incluso solicitudes simultáneas con la misma clave.
// La respuesta se confirma en la misma transacción que el inventario.
export async function runOnce(db, { scope, key, input }, operation) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO habitaciones.operaciones_idempotentes (alcance,clave,huella)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [scope, key, fingerprint],
    );
    const row = (
      await tx.query(
        `SELECT huella,respuesta,finalizada FROM habitaciones.operaciones_idempotentes
      WHERE alcance=$1 AND clave=$2 FOR UPDATE`,
        [scope, key],
      )
    ).rows[0];
    if (row.huella !== fingerprint)
      throw new AppError(
        409,
        'IDEMPOTENCIA_CONFLICTO',
        'La clave ya se usó con otra solicitud.',
      );
    if (row.finalizada) return row.respuesta;
    const result = await operation(tx);
    await tx.query(
      `UPDATE habitaciones.operaciones_idempotentes SET respuesta=$3::jsonb,finalizada=true
      WHERE alcance=$1 AND clave=$2`,
      [scope, key, JSON.stringify(result)],
    );
    return result;
  });
}
