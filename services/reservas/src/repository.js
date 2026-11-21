import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { withTransaction } from '../../shared/database.js';
import { validateRange } from './validation.js';

const COLUMNS = `reserva_id, huesped_id, habitacion_id, desde::text, hasta::text,
  personas, estado, total::text, moneda, bloqueo_id, cargo_id, version, creado_en, actualizado_en`;

export function reservation(row) {
  if (!row) return null;
  return {
    reservaId: row.reserva_id,
    huespedId: row.huesped_id,
    habitacionId: row.habitacion_id,
    desde: row.desde,
    hasta: row.hasta,
    personas: row.personas,
    estado: row.estado,
    total: row.total,
    moneda: row.moneda,
    bloqueoId: row.bloqueo_id,
    cargoId: row.cargo_id,
    version: row.version,
  };
}

export function createRepository(db, { clock = () => new Date() } = {}) {
  async function get(id, tx = db) {
    return reservation(
      (
        await tx.query(
          `SELECT ${COLUMNS} FROM reservas.reservas WHERE reserva_id=$1`,
          [id],
        )
      ).rows[0],
    );
  }
  async function byKey(user, action, key, tx = db) {
    return (
      await tx.query(
        `SELECT * FROM reservas.operaciones WHERE huesped_id=$1 AND accion=$2 AND clave=$3`,
        [user, action, key],
      )
    ).rows[0];
  }
  function verifyHash(op, hash) {
    if (op.huella !== hash)
      throw new AppError(
        409,
        'IDEMPOTENCIA_CONFLICTO',
        'La clave ya se uso con otra solicitud.',
      );
    return op;
  }
  async function saveOperation(tx, data) {
    const { user, action, key, hash, payload, id, reservaId, traceId } = data;
    return (
      await tx.query(
        `INSERT INTO reservas.operaciones
      (operacion_id,reserva_id,huesped_id,accion,clave,huella,entrada,contexto,fase)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING *`,
        [
          id,
          reservaId,
          user,
          action,
          key,
          hash,
          JSON.stringify(payload),
          JSON.stringify({ traceId }),
          action === 'CREAR' ? 'BLOQUEAR' : 'BLOQUEAR_CUENTA',
        ],
      )
    ).rows[0];
  }
  return {
    get,
    async own(id, user) {
      const row = await get(id);
      if (!row || row.huespedId !== user.toLowerCase())
        throw new AppError(
          404,
          'RESERVA_NO_ENCONTRADA',
          'No se encontro la reserva.',
        );
      return row;
    },
    async operation(id) {
      return (
        await db.query(
          'SELECT * FROM reservas.operaciones WHERE operacion_id=$1',
          [id],
        )
      ).rows[0];
    },
    async enqueue({ user, action, key, hash, input, reservaId, traceId }) {
      user = user.toLowerCase();
      try {
        return await withTransaction(db, async (tx) => {
          const previous = await byKey(user, action, key, tx);
          if (previous) return verifyHash(previous, hash);
          const id = randomUUID();
          let payload = input;
          if (action === 'CREAR') {
            validateRange(input, clock());
            reservaId = randomUUID();
            await tx.query(
              `INSERT INTO reservas.reservas
              (reserva_id,huesped_id,habitacion_id,desde,hasta,personas,estado)
              VALUES($1,$2,$3,$4::date,$5::date,$6,'PENDIENTE')`,
              [
                reservaId,
                user,
                input.habitacionId,
                input.desde,
                input.hasta,
                input.personas,
              ],
            );
          } else {
            const raw = (
              await tx.query(
                `SELECT ${COLUMNS} FROM reservas.reservas WHERE reserva_id=$1 FOR UPDATE`,
                [reservaId],
              )
            ).rows[0];
            const row = reservation(raw);
            if (!row || row.huespedId !== user)
              throw new AppError(
                404,
                'RESERVA_NO_ENCONTRADA',
                'No se encontro la reserva.',
              );
            // Under READ COMMITTED another transaction may have inserted this
            // operation while we waited for the reservation row lock. Recheck
            // its durable result before rejecting the now-transient state.
            const concurrent = await byKey(user, action, key, tx);
            if (concurrent) return verifyHash(concurrent, hash);
            if (row.estado !== 'CONFIRMADA')
              throw new AppError(
                409,
                'RESERVA_NO_MODIFICABLE',
                'La reserva debe estar confirmada y sin otra operacion en curso.',
              );
            payload =
              action === 'MODIFICAR'
                ? {
                    desde: input.desde ?? row.desde,
                    hasta: input.hasta ?? row.hasta,
                    personas: input.personas ?? row.personas,
                    original: row,
                  }
                : { original: row };
            if (action === 'MODIFICAR') validateRange(payload, clock());
            await tx.query(
              'UPDATE reservas.reservas SET estado=$2,actualizado_en=now() WHERE reserva_id=$1',
              [
                reservaId,
                action === 'MODIFICAR' ? 'MODIFICANDO' : 'CANCELANDO',
              ],
            );
          }
          return saveOperation(tx, {
            user,
            action,
            key,
            hash,
            payload,
            id,
            reservaId,
            traceId,
          });
        });
      } catch (error) {
        if (error.code === '23505') {
          const previous = await byKey(user, action, key);
          if (previous) return verifyHash(previous, hash);
          throw new AppError(
            409,
            'OPERACION_EN_CURSO',
            'La reserva tiene otra operacion en curso.',
          );
        }
        throw error;
      }
    },
    async claim(id, owner) {
      return (
        await db.query(
          `UPDATE reservas.operaciones SET lease_owner=$2,
        lease_hasta=now()+interval '60 seconds',intentos=intentos+1,actualizado_en=now()
        WHERE operacion_id=$1 AND estado='PENDIENTE'
        AND (lease_hasta IS NULL OR lease_hasta < now()) RETURNING *`,
          [id, owner],
        )
      ).rows[0];
    },
    async due(limit = 10) {
      return (
        await db.query(
          `SELECT operacion_id FROM reservas.operaciones
        WHERE estado='PENDIENTE' AND proximo_intento <= now()
        AND (lease_hasta IS NULL OR lease_hasta < now())
        ORDER BY creado_en LIMIT $1`,
          [limit],
        )
      ).rows.map((r) => r.operacion_id);
    },
    async advance(op, phase, context) {
      const row = (
        await db.query(
          `UPDATE reservas.operaciones SET fase=$3,contexto=$4::jsonb,
        lease_hasta=now()+interval '60 seconds',actualizado_en=now()
        WHERE operacion_id=$1 AND lease_owner=$2 AND estado='PENDIENTE' RETURNING *`,
          [op.operacion_id, op.lease_owner, phase, JSON.stringify(context)],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          503,
          'LEASE_PERDIDA',
          'La operacion se esta recuperando.',
        );
      return row;
    },
    async defer(op, code) {
      const delay = Math.min(60, 2 ** Math.min(op.intentos, 6));
      await db.query(
        `UPDATE reservas.operaciones SET lease_owner=NULL,lease_hasta=NULL,
        proximo_intento=now()+($3 * interval '1 second'),ultimo_error=$4,actualizado_en=now()
        WHERE operacion_id=$1 AND lease_owner=$2`,
        [op.operacion_id, op.lease_owner, delay, code],
      );
    },
    async finish(op) {
      return withTransaction(db, async (tx) => {
        const claimed = (
          await tx.query(
            'SELECT * FROM reservas.operaciones WHERE operacion_id=$1 AND lease_owner=$2 FOR UPDATE',
            [op.operacion_id, op.lease_owner],
          )
        ).rows[0];
        if (!claimed || claimed.estado !== 'PENDIENTE') return;
        const c = op.contexto;
        if (op.accion === 'CREAR') {
          await tx.query(
            `UPDATE reservas.reservas SET estado='CONFIRMADA',total=$2::numeric,
            bloqueo_id=$3,cargo_id=$4,actualizado_en=now() WHERE reserva_id=$1`,
            [op.reserva_id, c.total, c.bloqueoId, c.cargoId],
          );
          const eventoId = randomUUID();
          await tx.query(
            `INSERT INTO reservas.outbox(evento_id,reserva_id,tipo,payload)
            VALUES($1,$2,'ReservaConfirmada',$3::jsonb) ON CONFLICT(reserva_id,tipo) DO NOTHING`,
            [
              eventoId,
              op.reserva_id,
              JSON.stringify({
                reservaId: op.reserva_id,
                tipo: 'ReservaConfirmada',
                eventoId,
              }),
            ],
          );
        } else if (op.accion === 'MODIFICAR') {
          await tx.query(
            `UPDATE reservas.reservas SET estado='CONFIRMADA',desde=$2::date,hasta=$3::date,
            personas=$4,total=$5::numeric,version=version+1,actualizado_en=now() WHERE reserva_id=$1`,
            [
              op.reserva_id,
              op.entrada.desde,
              op.entrada.hasta,
              op.entrada.personas,
              c.total,
            ],
          );
        } else {
          await tx.query(
            "UPDATE reservas.reservas SET estado='CANCELADA',version=version+1,actualizado_en=now() WHERE reserva_id=$1",
            [op.reserva_id],
          );
        }
        const response =
          op.accion === 'CANCELAR' ? null : await get(op.reserva_id, tx);
        await tx.query(
          `UPDATE reservas.operaciones SET estado='COMPLETA',fase='TERMINADA',
          respuesta_http=$3,respuesta=$4::jsonb,lease_hasta=NULL,lease_owner=NULL,ultimo_error=NULL,
          actualizado_en=now() WHERE operacion_id=$1 AND lease_owner=$2`,
          [
            op.operacion_id,
            op.lease_owner,
            op.accion === 'CREAR' ? 201 : op.accion === 'MODIFICAR' ? 200 : 204,
            JSON.stringify(response),
          ],
        );
      });
    },
    async fail(op, failure) {
      await withTransaction(db, async (tx) => {
        const claimed = (
          await tx.query(
            'SELECT * FROM reservas.operaciones WHERE operacion_id=$1 AND lease_owner=$2 FOR UPDATE',
            [op.operacion_id, op.lease_owner],
          )
        ).rows[0];
        if (!claimed || claimed.estado !== 'PENDIENTE') return;
        await tx.query(
          'UPDATE reservas.reservas SET estado=$2,actualizado_en=now() WHERE reserva_id=$1',
          [op.reserva_id, op.accion === 'CREAR' ? 'FALLIDA' : 'CONFIRMADA'],
        );
        await tx.query(
          `UPDATE reservas.operaciones SET estado='FALLIDA',respuesta_http=$3,respuesta=$4::jsonb,
          fase='TERMINADA',lease_hasta=NULL,lease_owner=NULL,actualizado_en=now()
          WHERE operacion_id=$1 AND lease_owner=$2`,
          [
            op.operacion_id,
            op.lease_owner,
            failure.status,
            JSON.stringify({
              codigo: failure.codigo,
              mensaje: failure.mensaje,
              detalle: [],
            }),
          ],
        );
      });
    },
    async events() {
      return (
        await db.query(
          'SELECT * FROM reservas.outbox WHERE NOT enviado AND proximo_intento<=now() ORDER BY creado_en LIMIT 10',
        )
      ).rows;
    },
    async eventSent(id) {
      await db.query(
        'UPDATE reservas.outbox SET enviado=true,ultimo_error=NULL WHERE evento_id=$1',
        [id],
      );
    },
    async eventFailed(id, code) {
      await db.query(
        `UPDATE reservas.outbox SET intentos=intentos+1,ultimo_error=$2,
        proximo_intento=now()+interval '5 seconds' WHERE evento_id=$1`,
        [id, code],
      );
    },
    async ready() {
      await db.query('SELECT reserva_id FROM reservas.reservas LIMIT 1');
      await db.query('SELECT operacion_id FROM reservas.operaciones LIMIT 1');
      await db.query('SELECT evento_id FROM reservas.outbox LIMIT 1');
    },
  };
}
