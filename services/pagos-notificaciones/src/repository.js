import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '../../shared/database.js';
import { AppError } from '../../shared/errors.js';
import { parseMoney, formatMoney } from '../../shared/money.js';

const conflict = (code, message) => new AppError(409, code, message);
const fingerprint = (input) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const cargoColumns =
  'cargo_id, reserva_id, origen, origen_id, concepto, monto::text, moneda, estado';
const mapCargo = (r) => ({
  cargoId: r.cargo_id,
  reservaId: r.reserva_id,
  origen: r.origen,
  origenId: r.origen_id,
  concepto: r.concepto,
  monto: r.monto,
  moneda: r.moneda.trim(),
  estado: r.estado,
});
export const mapNotification = (r) => ({
  notificacionId: r.notificacion_id,
  reservaId: r.reserva_id,
  eventoId: r.evento_id,
  tipo: r.tipo,
  canal: r.canal,
  estado: r.estado,
  intentos: r.intentos,
  fechaEnvio: r.enviada_en ? new Date(r.enviada_en).toISOString() : null,
});

async function idempotent(db, scope, key, input, fn) {
  const hash = fingerprint(input);
  return withTransaction(db, async (tx) => {
    // INSERT bloquea reintentos concurrentes antes de cualquier efecto local.
    await tx.query(
      `INSERT INTO pagos.solicitudes_idempotentes(ambito,clave,huella)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [scope, key, hash],
    );
    const row = (
      await tx.query(
        `SELECT huella,estado_http,respuesta
      FROM pagos.solicitudes_idempotentes WHERE ambito=$1 AND clave=$2 FOR UPDATE`,
        [scope, key],
      )
    ).rows[0];
    if (row.huella !== hash)
      throw conflict(
        'IDEMPOTENCIA_CONFLICTO',
        'La clave ya se uso con otra solicitud.',
      );
    if (row.estado_http !== null)
      return { status: row.estado_http, body: row.respuesta };
    const result = await fn(tx);
    await tx.query(
      `UPDATE pagos.solicitudes_idempotentes SET estado_http=$3,respuesta=$4::jsonb
      WHERE ambito=$1 AND clave=$2`,
      [scope, key, result.status, JSON.stringify(result.body)],
    );
    return result;
  }).catch((error) => {
    if (error.code === '23505')
      throw conflict(
        'DUPLICIDAD_CONFLICTO',
        'Otro registro ya utiliza este origen o identificador.',
      );
    throw error;
  });
}

async function lockAccount(tx, id) {
  await tx.query(
    'INSERT INTO pagos.cuentas(reserva_id) VALUES($1) ON CONFLICT DO NOTHING',
    [id],
  );
  return (
    await tx.query(
      'SELECT operacion_id FROM pagos.cuentas WHERE reserva_id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
}
async function requireUnpaid(tx, id) {
  const paid = (
    await tx.query(
      "SELECT pago_id FROM pagos.pagos WHERE reserva_id=$1 AND estado='APROBADO' LIMIT 1",
      [id],
    )
  ).rows[0];
  if (paid)
    throw conflict(
      'CUENTA_PAGADA',
      'La cuenta tiene pagos. No se permiten anulaciones ni modificaciones automaticas.',
    );
}
async function ensureAccountLimit(tx, id, amount, exceptId = null) {
  const rows = (
    await tx.query(
      "SELECT cargo_id,monto::text FROM pagos.cargos WHERE reserva_id=$1 AND estado='ACTIVO'",
      [id],
    )
  ).rows;
  const total = rows
    .filter((r) => r.cargo_id !== exceptId)
    .reduce((sum, r) => sum + parseMoney(r.monto), parseMoney(amount));
  if (total > 999999999999n)
    throw new AppError(
      422,
      'LIMITE_CUENTA_EXCEDIDO',
      'El total excede el limite monetario permitido.',
    );
}
async function audit(
  tx,
  reservaId,
  action,
  resourceId,
  actor,
  traceId,
  detail = {},
) {
  await tx.query(
    `INSERT INTO pagos.auditoria(auditoria_id,reserva_id,accion,recurso_id,actor,trace_id,detalle)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      randomUUID(),
      reservaId,
      action,
      resourceId,
      actor,
      traceId,
      JSON.stringify(detail),
    ],
  );
}
async function enqueue(tx, input, traceId) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO pagos.notificaciones(notificacion_id,evento_id,reserva_id,tipo,trace_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(evento_id) DO NOTHING`,
    [id, input.eventoId, input.reservaId, input.tipo, traceId],
  );
  const n = (
    await tx.query('SELECT * FROM pagos.notificaciones WHERE evento_id=$1', [
      input.eventoId,
    ])
  ).rows[0];
  if (n.reserva_id !== input.reservaId || n.tipo !== input.tipo)
    throw conflict(
      'EVENTO_CONFLICTO',
      'El evento ya pertenece a otra notificacion.',
    );
  return { notificacionId: n.notificacion_id, estado: n.estado };
}
async function account(tx, id) {
  const cargos = (
    await tx.query(
      `SELECT ${cargoColumns} FROM pagos.cargos WHERE reserva_id=$1 ORDER BY creado_en,cargo_id`,
      [id],
    )
  ).rows.map(mapCargo);
  const payments = (
    await tx.query(
      "SELECT monto::text FROM pagos.pagos WHERE reserva_id=$1 AND estado='APROBADO'",
      [id],
    )
  ).rows;
  const total = cargos
    .filter((c) => c.estado === 'ACTIVO')
    .reduce((sum, c) => sum + parseMoney(c.monto), 0n);
  const paid = payments.reduce((sum, p) => sum + parseMoney(p.monto), 0n);
  return {
    reservaId: id,
    cargos,
    total: formatMoney(total),
    pagado: formatMoney(paid),
    saldo: formatMoney(total - paid),
    moneda: 'PEN',
  };
}

export function createRepository(db) {
  return {
    async replayPayment(user, key, input) {
      // El JWT ya autentico al sujeto. Solo se consulta su propio ambito; no se
      // necesita la disponibilidad actual de Reservas para repetir un resultado.
      const row = (
        await db.query(
          `SELECT huella,estado_http,respuesta
        FROM pagos.solicitudes_idempotentes WHERE ambito=$1 AND clave=$2`,
          [`huesped:${user}:pagar`, key],
        )
      ).rows[0];
      if (!row) return null;
      if (row.huella !== fingerprint(input))
        throw conflict(
          'IDEMPOTENCIA_CONFLICTO',
          'La clave ya se uso con otra solicitud.',
        );
      return row.estado_http === null
        ? null
        : { status: row.estado_http, body: row.respuesta };
    },
    account: (id) =>
      withTransaction(db, async (tx) => {
        await lockAccount(tx, id);
        return account(tx, id);
      }),
    async findCargo(id) {
      const r = (
        await db.query(
          `SELECT ${cargoColumns} FROM pagos.cargos WHERE cargo_id=$1`,
          [id],
        )
      ).rows[0];
      if (!r)
        throw new AppError(
          404,
          'CARGO_NO_ENCONTRADO',
          'No se encontro el cargo.',
        );
      return mapCargo(r);
    },
    async createCargo(key, input, traceId) {
      return idempotent(db, 'servicio:crear-cargo', key, input, async (tx) => {
        const guard = await lockAccount(tx, input.reservaId);
        if (guard.operacion_id)
          throw conflict(
            'CUENTA_EN_OPERACION',
            'La cuenta tiene una operacion en curso.',
          );
        await requireUnpaid(tx, input.reservaId);
        const prior = (
          await tx.query(
            `SELECT ${cargoColumns} FROM pagos.cargos WHERE origen=$1 AND origen_id=$2`,
            [input.origen, input.origenId],
          )
        ).rows[0];
        if (prior) {
          const old = mapCargo(prior);
          if (
            old.reservaId !== input.reservaId ||
            old.monto !== input.monto ||
            old.concepto !== input.concepto ||
            old.estado !== 'ACTIVO'
          )
            throw conflict(
              'ORIGEN_CONFLICTO',
              'El origen ya fue registrado con otros datos o anulado.',
            );
          return { status: 201, body: old };
        }
        await ensureAccountLimit(tx, input.reservaId, input.monto);
        const id = randomUUID();
        const row = (
          await tx.query(
            `INSERT INTO pagos.cargos(cargo_id,reserva_id,origen,origen_id,concepto,monto,moneda)
          VALUES($1,$2,$3,$4,$5,$6::numeric,$7) RETURNING ${cargoColumns}`,
            [
              id,
              input.reservaId,
              input.origen,
              input.origenId,
              input.concepto,
              input.monto,
              input.moneda,
            ],
          )
        ).rows[0];
        await tx.query(
          `INSERT INTO pagos.detalle_cargo(detalle_id,cargo_id,concepto,cantidad,precio_unitario)
          VALUES($1,$2,$3,1,$4::numeric)`,
          [randomUUID(), id, input.concepto, input.monto],
        );
        await audit(
          tx,
          input.reservaId,
          'CARGO_CREADO',
          id,
          'servicio',
          traceId,
          { monto: input.monto, concepto: input.concepto },
        );
        return { status: 201, body: mapCargo(row) };
      });
    },
    async guardAccount(key, id, operationId, traceId) {
      return idempotent(
        db,
        'servicio:bloquear-cuenta',
        key,
        { id, operationId },
        async (tx) => {
          const guard = await lockAccount(tx, id);
          await requireUnpaid(tx, id);
          if (guard.operacion_id && guard.operacion_id !== operationId)
            throw conflict(
              'CUENTA_EN_OPERACION',
              'Otra operacion tiene la cuenta bloqueada.',
            );
          await tx.query(
            'UPDATE pagos.cuentas SET operacion_id=$2 WHERE reserva_id=$1',
            [id, operationId],
          );
          await audit(
            tx,
            id,
            'CUENTA_BLOQUEADA',
            operationId,
            'servicio',
            traceId,
          );
          return {
            status: 200,
            body: {
              reservaId: id,
              operacionId: operationId,
              estado: 'BLOQUEADA',
            },
          };
        },
      );
    },
    async releaseAccount(key, id, operationId, traceId) {
      return idempotent(
        db,
        'servicio:desbloquear-cuenta',
        key,
        { id, operationId },
        async (tx) => {
          const guard = await lockAccount(tx, id);
          if (guard.operacion_id && guard.operacion_id !== operationId)
            throw conflict(
              'OPERACION_CONFLICTO',
              'La cuenta pertenece a otra operacion.',
            );
          await tx.query(
            'UPDATE pagos.cuentas SET operacion_id=NULL WHERE reserva_id=$1',
            [id],
          );
          await audit(
            tx,
            id,
            'CUENTA_LIBERADA',
            operationId,
            'servicio',
            traceId,
          );
          return { status: 204, body: null };
        },
      );
    },
    async updateCargo(key, id, input, traceId) {
      return idempotent(
        db,
        'servicio:modificar-cargo',
        key,
        { id, ...input },
        async (tx) => {
          let cargo = (
            await tx.query(
              `SELECT ${cargoColumns} FROM pagos.cargos WHERE cargo_id=$1`,
              [id],
            )
          ).rows[0];
          if (!cargo)
            throw new AppError(
              404,
              'CARGO_NO_ENCONTRADO',
              'No se encontro el cargo.',
            );
          const guard = await lockAccount(tx, cargo.reserva_id);
          if (guard.operacion_id !== input.operacionId)
            throw conflict(
              'OPERACION_CONFLICTO',
              'Se requiere el bloqueo de cuenta de la operacion.',
            );
          await requireUnpaid(tx, cargo.reserva_id);
          cargo = (
            await tx.query(
              `SELECT ${cargoColumns} FROM pagos.cargos WHERE cargo_id=$1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          if (cargo.estado !== 'ACTIVO')
            throw conflict('CARGO_ANULADO', 'El cargo esta anulado.');
          await ensureAccountLimit(tx, cargo.reserva_id, input.monto, id);
          const row = (
            await tx.query(
              `UPDATE pagos.cargos SET monto=$2::numeric,concepto=$3,actualizado_en=now()
          WHERE cargo_id=$1 RETURNING ${cargoColumns}`,
              [id, input.monto, input.concepto],
            )
          ).rows[0];
          await tx.query(
            'UPDATE pagos.detalle_cargo SET concepto=$2,precio_unitario=$3::numeric WHERE cargo_id=$1',
            [id, input.concepto, input.monto],
          );
          await audit(
            tx,
            cargo.reserva_id,
            'CARGO_MODIFICADO',
            id,
            'servicio',
            traceId,
            {
              anterior: { monto: cargo.monto, concepto: cargo.concepto },
              actual: { monto: input.monto, concepto: input.concepto },
            },
          );
          return { status: 200, body: mapCargo(row) };
        },
      );
    },
    async cancelCargo(key, id, operationId, traceId) {
      return idempotent(
        db,
        'servicio:anular-cargo',
        key,
        { id, operationId: operationId ?? null },
        async (tx) => {
          const cargo = (
            await tx.query(
              `SELECT ${cargoColumns} FROM pagos.cargos WHERE cargo_id=$1`,
              [id],
            )
          ).rows[0];
          if (!cargo)
            throw new AppError(
              404,
              'CARGO_NO_ENCONTRADO',
              'No se encontro el cargo.',
            );
          const guard = await lockAccount(tx, cargo.reserva_id);
          if (guard.operacion_id && guard.operacion_id !== operationId)
            throw conflict(
              'OPERACION_CONFLICTO',
              'La cuenta tiene una operacion en curso.',
            );
          await requireUnpaid(tx, cargo.reserva_id);
          await tx.query(
            "UPDATE pagos.cargos SET estado='ANULADO',actualizado_en=now() WHERE cargo_id=$1",
            [id],
          );
          await audit(
            tx,
            cargo.reserva_id,
            'CARGO_ANULADO',
            id,
            'servicio',
            traceId,
          );
          return { status: 204, body: null };
        },
      );
    },
    async pay(key, input, identity, traceId, verifyReservation) {
      return idempotent(
        db,
        `huesped:${identity.sub}:pagar`,
        key,
        input,
        async (tx) => {
          const guard = await lockAccount(tx, input.reservaId);
          if (guard.operacion_id)
            throw conflict(
              'CUENTA_EN_OPERACION',
              'No se puede pagar durante una modificacion o cancelacion.',
            );
          await verifyReservation();
          const balance = await account(tx, input.reservaId);
          if (parseMoney(balance.saldo) <= 0n)
            throw conflict(
              'CUENTA_SIN_SALDO',
              'La cuenta no tiene saldo pendiente.',
            );
          if (parseMoney(input.monto) !== parseMoney(balance.saldo))
            throw new AppError(
              422,
              'MONTO_NO_COINCIDE',
              'El monto debe coincidir exactamente con el saldo calculado.',
            );
          const id = randomUUID();
          // El simulador es determinista y sin efectos externos. No se guarda tokenPago.
          const approved = input.tokenPago === 'tok_aprobado';
          const state = approved ? 'APROBADO' : 'RECHAZADO';
          await tx.query(
            `INSERT INTO pagos.pagos(pago_id,reserva_id,huesped_id,monto,metodo,estado,referencia_externa)
          VALUES($1,$2,$3,$4::numeric,'SIMULADO',$5,$6)`,
            [
              id,
              input.reservaId,
              identity.sub,
              input.monto,
              state,
              `simulado:${id}`,
            ],
          );
          const notification = approved
            ? await enqueue(
                tx,
                {
                  eventoId: id,
                  reservaId: input.reservaId,
                  tipo: 'PagoConfirmado',
                },
                traceId,
              )
            : null;
          await audit(
            tx,
            input.reservaId,
            `PAGO_${state}`,
            id,
            identity.sub,
            traceId,
            { monto: input.monto, moneda: 'PEN', estado: state },
          );
          return {
            status: 201,
            body: {
              pagoId: id,
              reservaId: input.reservaId,
              estado: state,
              monto: input.monto,
              moneda: 'PEN',
              ...(notification
                ? { notificacionId: notification.notificacionId }
                : {}),
            },
          };
        },
      );
    },
    async enqueue(key, input, traceId) {
      return idempotent(db, 'servicio:notificar', key, input, async (tx) => {
        const body = await enqueue(tx, input, traceId);
        await audit(
          tx,
          input.reservaId,
          'NOTIFICACION_ENCOLADA',
          body.notificacionId,
          'servicio',
          traceId,
        );
        return { status: 202, body };
      });
    },
    async notification(id) {
      const n = (
        await db.query(
          'SELECT * FROM pagos.notificaciones WHERE notificacion_id=$1',
          [id],
        )
      ).rows[0];
      if (!n)
        throw new AppError(
          404,
          'NOTIFICACION_NO_ENCONTRADA',
          'No se encontro la notificacion.',
        );
      return mapNotification(n);
    },
    async ready() {
      await db.query('SELECT reserva_id FROM pagos.cuentas LIMIT 1');
    },
  };
}
