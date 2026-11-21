import { withTransaction } from '../../shared/database.js';

export function createNotificationWorker({
  db,
  sender,
  logger = console,
  maxAttempts = 5,
}) {
  const deliver =
    sender ??
    (async (notification) => {
      const reference = `simulado:${notification.evento_id}`;
      // Repetir tras un crash no duplica la entrega simulada.
      await db.query(
        `INSERT INTO pagos.entregas_simuladas(evento_id,referencia)
      VALUES($1,$2) ON CONFLICT(evento_id) DO NOTHING`,
        [notification.evento_id, reference],
      );
      return reference;
    });
  let running = false;
  return async function processNotifications({ batchSize = 10 } = {}) {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      for (let i = 0; i < batchSize; i++) {
        const row = await withTransaction(db, async (tx) => {
          const n = (
            await tx.query(`SELECT * FROM pagos.notificaciones WHERE estado='PENDIENTE'
            AND proximo_intento_en<=now() AND (bloqueada_hasta IS NULL OR bloqueada_hasta<now())
            ORDER BY creada_en FOR UPDATE SKIP LOCKED LIMIT 1`)
          ).rows[0];
          if (!n) return null;
          await tx.query(
            `UPDATE pagos.notificaciones SET intentos=intentos+1,
            bloqueada_hasta=now()+interval '30 seconds' WHERE notificacion_id=$1`,
            [n.notificacion_id],
          );
          return { ...n, intentos: n.intentos + 1 };
        });
        if (!row) break;
        count++;
        try {
          const reference = await deliver(row);
          await db.query(
            `UPDATE pagos.notificaciones SET estado='ENVIADA',enviada_en=now(),
            referencia_entrega=$2,bloqueada_hasta=NULL WHERE notificacion_id=$1 AND intentos=$3`,
            [row.notificacion_id, reference, row.intentos],
          );
        } catch {
          const exhausted = row.intentos >= maxAttempts;
          await db.query(
            `UPDATE pagos.notificaciones SET estado=$2,bloqueada_hasta=NULL,
            proximo_intento_en=now()+make_interval(secs=>$3) WHERE notificacion_id=$1 AND intentos=$4`,
            [
              row.notificacion_id,
              exhausted ? 'FALLIDA' : 'PENDIENTE',
              Math.min(300, 2 ** row.intentos),
              row.intentos,
            ],
          );
          logger.error(
            JSON.stringify({
              servicio: 'pagos-notificaciones',
              traceId: row.trace_id,
              codigo: 'AVISO_REINTENTO',
              notificacionId: row.notificacion_id,
              intentos: row.intentos,
            }),
          );
        }
      }
      return count;
    } finally {
      running = false;
    }
  };
}
