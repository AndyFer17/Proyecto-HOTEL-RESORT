import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { withTransaction } from '../database.js';

const ROOM_COLUMNS = `habitacion_id, numero, tipo, capacidad,
  tarifa_noche::text AS tarifa_noche, moneda`;

function mapRoom(row) {
  if (!row) return null;
  return {
    habitacionId: row.habitacion_id,
    numero: row.numero,
    tipo: row.tipo,
    capacidad: row.capacidad,
    tarifaNoche: row.tarifa_noche,
    moneda: row.moneda,
  };
}

export function createHabitacionesRepository(db) {
  return {
    async findAvailable({ desde, hasta, personas }) {
      const result = await db.query(
        `SELECT ${ROOM_COLUMNS} FROM habitaciones.habitaciones h
         WHERE h.activa AND h.capacidad >= $3
         AND NOT EXISTS (
           SELECT 1 FROM habitaciones.bloqueos b
           WHERE b.habitacion_id = h.habitacion_id
           AND daterange(b.desde, b.hasta, '[)')
               && daterange($1::date, $2::date, '[)')
           AND (b.estado = 'CONFIRMADO'
                OR (b.estado = 'BLOQUEADO' AND b.vence_en > now()))
         )
         ORDER BY h.tarifa_noche, h.numero`,
        [desde, hasta, personas],
      );
      return result.rows.map(mapRoom);
    },

    async findById(id) {
      const result = await db.query(
        `SELECT ${ROOM_COLUMNS} FROM habitaciones.habitaciones h
         WHERE h.habitacion_id = $1 AND h.activa`,
        [id],
      );
      return mapRoom(result.rows[0]);
    },

    // Bloqueo atomico e idempotente. Devuelve { status, body }.
    async createBloqueo({ key, huella, input, ttlSeconds }) {
      return withTransaction(db, async (tx) => {
        const previous = (
          await tx.query(
            `SELECT huella, estado_http, respuesta
             FROM habitaciones.solicitudes_idempotentes WHERE clave = $1`,
            [key],
          )
        ).rows[0];
        if (previous) {
          if (previous.huella !== huella)
            throw new AppError(
              409,
              'IDEMPOTENCIA_CONFLICTO',
              'La clave ya se uso con otra solicitud.',
            );
          return { status: previous.estado_http, body: previous.respuesta };
        }
        const room = (
          await tx.query(
            `SELECT ${ROOM_COLUMNS} FROM habitaciones.habitaciones h
             WHERE h.habitacion_id = $1 AND h.activa`,
            [input.habitacionId],
          )
        ).rows[0];
        if (!room)
          throw new AppError(
            404,
            'HABITACION_NO_ENCONTRADA',
            'No se encontro la habitacion.',
          );
        if (input.personas > room.capacidad)
          throw new AppError(
            422,
            'CAPACIDAD_EXCEDIDA',
            'La habitacion no admite esa cantidad de personas.',
          );
        // Liberar bloqueos temporales vencidos que estorban.
        await tx.query(
          `UPDATE habitaciones.bloqueos
           SET estado = 'EXPIRADO', actualizado_en = now()
           WHERE estado = 'BLOQUEADO' AND vence_en <= now()
           AND (habitacion_id = $1 OR reserva_id = $2)`,
          [input.habitacionId, input.reservaId],
        );
        let row;
        try {
          row = (
            await tx.query(
              `INSERT INTO habitaciones.bloqueos
               (bloqueo_id, reserva_id, habitacion_id, desde, hasta,
                personas, total, estado, vence_en)
               VALUES ($1, $2, $3, $4::date, $5::date, $6,
                 $7::numeric * ($5::date - $4::date), 'BLOQUEADO',
                 now() + make_interval(secs => $8))
               RETURNING bloqueo_id, habitacion_id, desde::text,
                 hasta::text, vence_en, total::text`,
              [
                randomUUID(),
                input.reservaId,
                input.habitacionId,
                input.desde,
                input.hasta,
                input.personas,
                room.tarifa_noche,
                ttlSeconds,
              ],
            )
          ).rows[0];
        } catch (error) {
          if (error.code === '23P01')
            throw new AppError(
              409,
              'HABITACION_NO_DISPONIBLE',
              'La habitacion no esta disponible en esas fechas.',
            );
          if (
            error.code === '23505' &&
            error.constraint === 'bloqueos_una_activa_por_reserva'
          )
            throw new AppError(
              409,
              'RESERVA_CON_BLOQUEO_ACTIVO',
              'La reserva ya tiene un bloqueo activo.',
            );
          throw error;
        }
        const body = {
          bloqueoId: row.bloqueo_id,
          habitacionId: row.habitacion_id,
          desde: row.desde,
          hasta: row.hasta,
          venceEn: new Date(row.vence_en).toISOString(),
          total: row.total,
          moneda: 'PEN',
        };
        try {
          await tx.query(
            `INSERT INTO habitaciones.solicitudes_idempotentes
             (clave, huella, estado_http, respuesta)
             VALUES ($1, $2, 201, $3::jsonb)`,
            [key, huella, JSON.stringify(body)],
          );
        } catch (error) {
          if (error.code === '23505')
            throw new AppError(
              409,
              'SOLICITUD_EN_CURSO',
              'La solicitud con esa clave ya esta en proceso.',
            );
          throw error;
        }
        return { status: 201, body };
      });
    },

    async confirmBloqueo(id) {
      return withTransaction(db, async (tx) => {
        const row = (
          await tx.query(
            `SELECT estado, vence_en > now() AS vigente
             FROM habitaciones.bloqueos WHERE bloqueo_id = $1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!row) return 'NO_ENCONTRADO';
        if (row.estado === 'CONFIRMADO') return 'CONFIRMADO';
        if (row.estado === 'BLOQUEADO' && row.vigente) {
          await tx.query(
            `UPDATE habitaciones.bloqueos
             SET estado = 'CONFIRMADO', actualizado_en = now()
             WHERE bloqueo_id = $1`,
            [id],
          );
          return 'CONFIRMADO';
        }
        if (row.estado === 'BLOQUEADO')
          await tx.query(
            `UPDATE habitaciones.bloqueos
             SET estado = 'EXPIRADO', actualizado_en = now()
             WHERE bloqueo_id = $1`,
            [id],
          );
        return 'NO_CONFIRMABLE';
      });
    },

    async releaseBloqueo(id) {
      return withTransaction(db, async (tx) => {
        const row = (
          await tx.query(
            `SELECT estado FROM habitaciones.bloqueos
             WHERE bloqueo_id = $1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!row) return 'NO_ENCONTRADO';
        if (row.estado === 'BLOQUEADO' || row.estado === 'CONFIRMADO')
          await tx.query(
            `UPDATE habitaciones.bloqueos
             SET estado = 'LIBERADO', actualizado_en = now()
             WHERE bloqueo_id = $1`,
            [id],
          );
        return 'LIBERADO';
      });
    },

    async ready() {
      await db.query(
        'SELECT habitacion_id FROM habitaciones.habitaciones LIMIT 1',
      );
    },
  };
}