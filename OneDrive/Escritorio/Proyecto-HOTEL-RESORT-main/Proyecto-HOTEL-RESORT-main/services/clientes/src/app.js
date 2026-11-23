import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import {
  registrationSchema,
  loginSchema,
  idSchema,
  parse,
} from './validation.js';
import { createClientesRepository } from './repositories/clientes.js';
import { createClientesService } from './domain/clientes.js';

export async function createApp({
  db,
  tokens,
  config,
  logger = console,
  authLimit = 30,
}) {
  const app = express();
  const repository = createClientesRepository(db);
  const service = await createClientesService(
    repository,
    tokens,
    config.JWT_TTL_SECONDS,
  );
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    req.traceId = randomUUID();
    res.setHeader('X-Request-Id', req.traceId);
    res.setHeader('Cache-Control', 'no-store');
    const start = performance.now();
    res.on('finish', () =>
      logger.info(
        JSON.stringify({
          servicio: 'clientes',
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
  const limit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: authLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) =>
      next(
        new AppError(
          429,
          'DEMASIADAS_SOLICITUDES',
          'Intenta nuevamente más tarde.',
        ),
      ),
  });
  app.use(['/api/v1/clientes', '/api/v1/auth/login'], (req, res, next) => {
    if (req.method === 'POST') return limit(req, res, next);
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
  async function authenticate(req, res, next) {
    const value = req.get('authorization');
    if (!value || !/^Bearer \S+$/i.test(value))
      throw new AppError(
        401,
        'NO_AUTENTICADO',
        'Se requiere un token Bearer válido.',
      );
    try {
      req.identity = await tokens.verify(value.split(' ')[1]);
    } catch {
      throw new AppError(401, 'TOKEN_INVALIDO', 'Token inválido o vencido.');
    }
    next();
  }
  app.get('/health/live', (req, res) =>
    res.json({ servicio: 'clientes', estado: 'OK' }),
  );
  app.get('/health/ready', async (req, res) => {
    try {
      await repository.ready();
    } catch {
      throw new AppError(
        503,
        'NO_DISPONIBLE',
        'La persistencia no está disponible.',
      );
    }
    res.json({ servicio: 'clientes', estado: 'OK' });
  });
  app.get('/.well-known/jwks.json', (req, res) => res.json(tokens.jwks));
  app.post('/api/v1/clientes', requireJson, async (req, res) => {
    const client = await service.register(parse(registrationSchema, req.body));
    res
      .location(`/api/v1/clientes/${client.clienteId}`)
      .status(201)
      .json(client);
  });
  app.post('/api/v1/auth/login', requireJson, async (req, res) => {
    res.json(await service.login(parse(loginSchema, req.body)));
  });
  app.get('/api/v1/clientes/:id', authenticate, async (req, res) => {
    res.json(
      await service.getProfile(parse(idSchema, req.params.id), req.identity),
    );
  });
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
    if (
      error.type === 'charset.unsupported' ||
      error.type === 'encoding.unsupported'
    )
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
