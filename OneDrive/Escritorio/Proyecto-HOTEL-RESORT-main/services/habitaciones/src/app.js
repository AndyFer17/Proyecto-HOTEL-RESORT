import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import {
  disponibilidadSchema,
  bloqueoSchema,
  idSchema,
  idempotencySchema,
  parse,
} from './validation.js';
import { createHabitacionesRepository } from './repositories/habitaciones.js';
import { createHabitacionesService } from './domain/habitaciones.js';
import { createServiceAuth } from './security/service-auth.js';

export function createApp({ db, config, logger = console, clock }) {
  const app = express();
  const repository = createHabitacionesRepository(db);
  const service = createHabitacionesService(repository, {
    ttlSeconds: config.BLOQUEO_TTL_SECONDS,
    clock,
  });
  const requireService = createServiceAuth(config.SERVICE_TOKEN);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    // Reutiliza el traceId que envie Reservas para correlacionar logs.
    const incoming = req.get('x-request-id');
    req.traceId = idSchema.safeParse(incoming).success
      ? incoming
      : randomUUID();
    res.setHeader('X-Request-Id', req.traceId);
    res.setHeader('Cache-Control', 'no-store');
    const start = performance.now();
    res.on('finish', () =>
      logger.info(
        JSON.stringify({
          servicio: 'habitaciones',
          traceId: req.traceId,
          metodo: req.method,
          ruta: req.route?.path ?? 'sin-ruta',
          estado: res.statusCode,
          duracionMs: Math.round(performance.now() - start),
        }),
      ),
    );
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  function requireJson(req, res, next) {
    if (!req.is('application/json'))
      return next(
        new AppError(
          415,
          'TIPO_NO_SOPORTADO',
          'Usa Content-Type application/json.',
        ),
      );
    next();
  }
  function idempotencyKey(req) {
    const value = req.get('idempotency-key');
    if (!idempotencySchema.safeParse(value).success)
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_INVALIDA',
        'Envia el header Idempotency-Key con un UUID.',
        [{ campo: 'Idempotency-Key', regla: 'invalid_uuid' }],
      );
    return value;
  }

  app.get('/health/live', (req, res) =>
    res.json({ servicio: 'habitaciones', estado: 'OK' }),
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
    res.json({ servicio: 'habitaciones', estado: 'OK' });
  });

  // Publicos: consulta de disponibilidad y de habitacion.
  app.get('/api/v1/habitaciones/disponibilidad', async (req, res) => {
    res.json(
      await service.disponibilidad(parse(disponibilidadSchema, req.query)),
    );
  });
  app.get('/api/v1/habitaciones/:id', async (req, res) => {
    res.json(await service.obtener(parse(idSchema, req.params.id)));
  });

  // Internos: solo Reservas, con identidad de servicio.
  app.post(
    '/api/v1/interno/bloqueos',
    requireService,
    requireJson,
    async (req, res) => {
      const key = idempotencyKey(req);
      const { status, body } = await service.bloquear(
        key,
        parse(bloqueoSchema, req.body),
      );
      res.status(status).json(body);
    },
  );
  app.put(
    '/api/v1/interno/bloqueos/:id/confirmacion',
    requireService,
    async (req, res) => {
      idempotencyKey(req);
      res.json(await service.confirmar(parse(idSchema, req.params.id)));
    },
  );
  app.delete(
    '/api/v1/interno/bloqueos/:id',
    requireService,
    async (req, res) => {
      idempotencyKey(req);
      await service.liberar(parse(idSchema, req.params.id));
      res.status(204).end();
    },
  );

  app.use((req, res, next) =>
    next(new AppError(404, 'RUTA_NO_ENCONTRADA', 'La ruta no existe.')),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let known = error;
    if (error.type === 'entity.parse.failed')
      known = new AppError(
        400,
        'JSON_INVALIDO',
        'El cuerpo no es JSON valido.',
      );
    if (error.type === 'entity.too.large')
      known = new AppError(
        413,
        'CUERPO_DEMASIADO_GRANDE',
        'El cuerpo supera 16 KB.',
      );
    if (
      error.type === 'charset.unsupported' ||
      error.type === 'encoding.unsupported'
    )
      known = new AppError(
        415,
        'TIPO_NO_SOPORTADO',
        'Codificacion no soportada.',
      );
    if (!(known instanceof AppError)) {
      logger.error(
        JSON.stringify({ traceId: req.traceId, codigo: 'ERROR_INTERNO' }),
      );
      known = new AppError(500, 'ERROR_INTERNO', 'Ocurrio un error interno.');
    }
    if (known.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(known.status).json({
      codigo: known.code,
      mensaje: known.message,
      detalle: known.details,
      traceId: req.traceId,
    });
  });
  return app;
}