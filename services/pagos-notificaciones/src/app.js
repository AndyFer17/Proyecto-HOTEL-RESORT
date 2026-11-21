import { AppError } from '../../shared/errors.js';
import {
  createHttpApp,
  finishApp,
  requireJson,
  parse,
  idempotencyKey,
} from '../../shared/http.js';
import { authenticate, serviceAuth } from '../../shared/security.js';
import { callService } from '../../shared/client.js';
import { createRepository } from './repository.js';
import { createNotificationWorker } from './notifications.js';
import {
  idSchema,
  cargoSchema,
  cargoUpdateSchema,
  paymentSchema,
  notificationSchema,
  operationSchema,
} from './validation.js';

export function createApp({
  db,
  tokens,
  config,
  logger = console,
  resolveReservation,
  notificationSender,
}) {
  const app = createHttpApp({ service: 'pagos-notificaciones', logger });
  const repo = createRepository(db);
  const user = authenticate(tokens);
  const internal = serviceAuth(config.SERVICE_TOKEN);
  const resolve =
    resolveReservation ??
    (async (id, traceId) =>
      (
        await callService(
          config.RESERVAS_URL,
          `/api/v1/interno/reservas/${id}/titular`,
          { token: config.SERVICE_TOKEN, traceId },
        )
      ).body);
  async function reservation(id, traceId) {
    const r = await resolve(id, traceId);
    if (!r || r.reservaId !== id || !idSchema.safeParse(r.huespedId).success)
      throw new AppError(
        503,
        'CONTRATO_DEPENDENCIA_INVALIDO',
        'La dependencia no devolvio una identidad valida.',
      );
    return r;
  }
  async function owned(id, identity, traceId, forPayment = false) {
    const r = await reservation(id, traceId);
    if (r.huespedId !== identity.sub)
      throw new AppError(
        403,
        'SIN_PERMISO',
        'Solo puedes acceder a tu propia cuenta.',
      );
    if (forPayment && r.estado !== 'CONFIRMADA')
      throw new AppError(
        409,
        'RESERVA_NO_PAGABLE',
        'La reserva debe estar confirmada para pagar.',
      );
    return r;
  }
  function respond(res, result) {
    if (result.status === 204) return res.status(204).end();
    return res.status(result.status).json(result.body);
  }
  app.get('/health/live', (req, res) =>
    res.json({ servicio: 'pagos-notificaciones', estado: 'OK' }),
  );
  app.get('/health/ready', async (req, res) => {
    try {
      await repo.ready();
    } catch {
      throw new AppError(
        503,
        'NO_DISPONIBLE',
        'La persistencia no esta disponible.',
      );
    }
    res.json({ servicio: 'pagos-notificaciones', estado: 'OK' });
  });
  app.get('/api/v1/cuentas/:reservaId', user, async (req, res) => {
    const id = parse(idSchema, req.params.reservaId);
    await owned(id, req.identity, req.traceId);
    res.json(await repo.account(id));
  });
  app.post('/api/v1/pagos', user, requireJson, async (req, res) => {
    const input = parse(paymentSchema, req.body);
    const key = idempotencyKey(req);
    const replay = await repo.replayPayment(req.identity.sub, key, input);
    if (replay) return respond(res, replay);
    await owned(input.reservaId, req.identity, req.traceId);
    respond(
      res,
      await repo.pay(key, input, req.identity, req.traceId, () =>
        owned(input.reservaId, req.identity, req.traceId, true),
      ),
    );
  });
  app.post(
    '/api/v1/interno/cargos',
    internal,
    requireJson,
    async (req, res) => {
      const input = parse(cargoSchema, req.body);
      const key = idempotencyKey(req);
      const r = await reservation(input.reservaId, req.traceId);
      if (!['PENDIENTE', 'CONFIRMADA'].includes(r.estado))
        throw new AppError(
          409,
          'RESERVA_NO_ADMITE_CARGOS',
          'La reserva no admite cargos.',
        );
      respond(res, await repo.createCargo(key, input, req.traceId));
    },
  );
  app.put(
    '/api/v1/interno/cuentas/:reservaId/operacion',
    internal,
    requireJson,
    async (req, res) => {
      const id = parse(idSchema, req.params.reservaId);
      const input = parse(operationSchema, req.body);
      const key = idempotencyKey(req);
      await reservation(id, req.traceId);
      respond(
        res,
        await repo.guardAccount(key, id, input.operacionId, req.traceId),
      );
    },
  );
  app.delete(
    '/api/v1/interno/cuentas/:reservaId/operacion/:operacionId',
    internal,
    async (req, res) => {
      respond(
        res,
        await repo.releaseAccount(
          idempotencyKey(req),
          parse(idSchema, req.params.reservaId),
          parse(idSchema, req.params.operacionId),
          req.traceId,
        ),
      );
    },
  );
  app.patch(
    '/api/v1/interno/cargos/:id',
    internal,
    requireJson,
    async (req, res) => {
      respond(
        res,
        await repo.updateCargo(
          idempotencyKey(req),
          parse(idSchema, req.params.id),
          parse(cargoUpdateSchema, req.body),
          req.traceId,
        ),
      );
    },
  );
  app.delete('/api/v1/interno/cargos/:id', internal, async (req, res) => {
    const operation = req.get('x-operacion-id');
    respond(
      res,
      await repo.cancelCargo(
        idempotencyKey(req),
        parse(idSchema, req.params.id),
        operation ? parse(idSchema, operation) : undefined,
        req.traceId,
      ),
    );
  });
  app.post(
    '/api/v1/interno/notificaciones',
    internal,
    requireJson,
    async (req, res) => {
      const input = parse(notificationSchema, req.body);
      const key = idempotencyKey(req);
      await reservation(input.reservaId, req.traceId);
      respond(res, await repo.enqueue(key, input, req.traceId));
    },
  );
  app.get('/api/v1/notificaciones/:id', user, async (req, res) => {
    const notification = await repo.notification(
      parse(idSchema, req.params.id),
    );
    await owned(notification.reservaId, req.identity, req.traceId);
    res.json(notification);
  });
  app.locals.processNotifications = createNotificationWorker({
    db,
    sender: notificationSender,
    logger,
  });
  finishApp(app, { logger });
  return app;
}
