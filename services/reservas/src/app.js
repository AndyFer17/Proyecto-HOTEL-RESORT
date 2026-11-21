import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import {
  createHttpApp,
  finishApp,
  requireJson,
  parse,
  idempotencyKey,
} from '../../shared/http.js';
import { authenticate, serviceAuth } from '../../shared/security.js';
import { crearSchema, modificarSchema, idSchema } from './validation.js';
import { createRepository } from './repository.js';
import { createCoordinator } from './saga.js';

export function createApp({
  db,
  tokens,
  config,
  logger = console,
  clock,
  call,
}) {
  const app = createHttpApp({ service: 'reservas', logger });
  const repository = createRepository(db, { clock });
  const coordinator = createCoordinator(repository, config, { call, logger });
  const auth = authenticate(tokens);
  const internal = serviceAuth(config.SERVICE_TOKEN);
  app.locals.repository = repository;
  app.locals.coordinator = coordinator;
  app.get('/health/live', (req, res) =>
    res.json({ servicio: 'reservas', estado: 'OK' }),
  );
  app.get('/health/ready', async (req, res) => {
    try {
      await repository.ready();
    } catch {
      throw new AppError(
        503,
        'NO_DISPONIBLE',
        'La persistencia no esta disponible.',
      );
    }
    res.json({ servicio: 'reservas', estado: 'OK' });
  });
  app.get(
    '/api/v1/interno/reservas/:id/titular',
    internal,
    async (req, res) => {
      const row = await repository.get(parse(idSchema, req.params.id));
      if (!row)
        throw new AppError(
          404,
          'RESERVA_NO_ENCONTRADA',
          'No se encontro la reserva.',
        );
      res.json({
        reservaId: row.reservaId,
        huespedId: row.huespedId,
        estado: row.estado,
      });
    },
  );
  app.get('/api/v1/reservas/:id', auth, async (req, res) => {
    res.json(
      await repository.own(parse(idSchema, req.params.id), req.identity.sub),
    );
  });

  async function mutate(req, res, action, input, reservaId) {
    const key = idempotencyKey(req);
    const hash = createHash('sha256')
      .update(JSON.stringify({ reservaId: reservaId ?? null, ...input }))
      .digest('hex');
    let op = await repository.enqueue({
      user: req.identity.sub,
      action,
      key,
      hash,
      input,
      reservaId,
      traceId: req.traceId,
    });
    if (op.estado === 'PENDIENTE') {
      let timer;
      try {
        await Promise.race([
          coordinator.process(op.operacion_id),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      op = await repository.operation(op.operacion_id);
    }
    if (op.estado === 'PENDIENTE') {
      const row = await repository.get(op.reserva_id);
      return res
        .location(`/api/v1/reservas/${op.reserva_id}`)
        .status(202)
        .json({
          operacionId: op.operacion_id,
          reservaId: op.reserva_id,
          estado: row.estado,
          fase: op.fase,
          mensaje:
            'Operacion persistida; el worker reintentara las dependencias pendientes.',
        });
    }
    if (op.estado === 'FALLIDA')
      return res
        .status(op.respuesta_http)
        .json({ ...op.respuesta, traceId: req.traceId });
    if (op.respuesta_http === 204) return res.status(204).end();
    return res
      .location(`/api/v1/reservas/${op.reserva_id}`)
      .status(op.respuesta_http)
      .json(op.respuesta);
  }
  app.post('/api/v1/reservas', auth, requireJson, async (req, res) =>
    mutate(req, res, 'CREAR', parse(crearSchema, req.body)),
  );
  app.patch('/api/v1/reservas/:id', auth, requireJson, async (req, res) =>
    mutate(
      req,
      res,
      'MODIFICAR',
      parse(modificarSchema, req.body),
      parse(idSchema, req.params.id),
    ),
  );
  app.delete('/api/v1/reservas/:id', auth, async (req, res) => {
    if (req.body !== undefined)
      throw new AppError(
        400,
        'CUERPO_NO_PERMITIDO',
        'Cancelar no admite cuerpo.',
      );
    return mutate(req, res, 'CANCELAR', {}, parse(idSchema, req.params.id));
  });
  return finishApp(app, { logger });
}
