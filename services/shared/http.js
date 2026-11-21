import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';

export const idSchema = z.string().uuid();

export function createHttpApp({ service, logger = console, limit = 300 }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(helmet());
  app.use((req, res, next) => {
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
          servicio: service,
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
  app.use(
    rateLimit({
      windowMs: 60000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/health/'),
      handler: (req, res, next) =>
        next(
          new AppError(
            429,
            'DEMASIADAS_SOLICITUDES',
            'Intenta nuevamente más tarde.',
          ),
        ),
    }),
  );
  app.use(express.json({ limit: '16kb', strict: true }));
  return app;
}

export function finishApp(app, { logger = console } = {}) {
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
        'El cuerpo no es JSON válido.',
      );
    if (error.type === 'entity.too.large')
      known = new AppError(
        413,
        'CUERPO_DEMASIADO_GRANDE',
        'El cuerpo supera 16 KB.',
      );
    if (['charset.unsupported', 'encoding.unsupported'].includes(error.type))
      known = new AppError(
        415,
        'TIPO_NO_SOPORTADO',
        'Codificación no soportada.',
      );
    if (!(known instanceof AppError)) {
      logger.error(
        JSON.stringify({ traceId: req.traceId, codigo: 'ERROR_INTERNO' }),
      );
      known = new AppError(500, 'ERROR_INTERNO', 'Ocurrió un error interno.');
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

export function requireJson(req, res, next) {
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

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      400,
      'DATOS_INVALIDOS',
      'Revisa los campos de la solicitud.',
      result.error.issues.map((i) => ({
        campo: i.path.join('.'),
        regla: i.code,
      })),
    );
  return result.data;
}

export function idempotencyKey(req) {
  const key = req.get('idempotency-key');
  if (!idSchema.safeParse(key).success)
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_INVALIDA',
      'Envía Idempotency-Key con un UUID.',
    );
  return key.toLowerCase();
}
