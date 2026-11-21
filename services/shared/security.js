import { createHash, timingSafeEqual } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError } from './errors.js';

export function serviceAuth(expected) {
  if (typeof expected !== 'string' || expected.length < 32)
    throw new Error('SERVICE_TOKEN debe tener al menos 32 caracteres.');
  const digest = createHash('sha256').update(expected).digest();
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    const actual = createHash('sha256')
      .update(match?.[1] ?? '')
      .digest();
    if (!match || !timingSafeEqual(actual, digest))
      return next(
        new AppError(
          401,
          'SERVICIO_NO_AUTORIZADO',
          'Se requiere identidad de servicio válida.',
        ),
      );
    next();
  };
}

export async function createVerifier(config) {
  const publicKey = await importSPKI(
    Buffer.from(config.JWT_PUBLIC_KEY_BASE64, 'base64').toString('utf8'),
    'RS256',
  );
  return {
    async verify(token) {
      const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: config.JWT_ISSUER ?? 'resort-clientes',
        audience: config.JWT_AUDIENCE ?? 'resort-api',
        requiredClaims: ['sub', 'iat', 'exp', 'jti', 'rol'],
        maxTokenAge: '20m',
      });
      if (
        protectedHeader.typ !== 'JWT' ||
        payload.rol !== 'HUESPED' ||
        !z.string().uuid().safeParse(payload.sub).success
      )
        throw new Error('Identidad inválida.');
      return payload;
    },
  };
}

export function authenticate(tokens) {
  return async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '');
    if (!match)
      throw new AppError(
        401,
        'NO_AUTENTICADO',
        'Se requiere un token Bearer válido.',
      );
    try {
      req.identity = await tokens.verify(match[1]);
    } catch {
      throw new AppError(401, 'TOKEN_INVALIDO', 'Token inválido o vencido.');
    }
    next();
  };
}
