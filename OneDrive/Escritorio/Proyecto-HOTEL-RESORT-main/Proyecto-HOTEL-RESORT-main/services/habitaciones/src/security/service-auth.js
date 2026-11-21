import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

function digest(value) {
  return createHash('sha256').update(value).digest();
}

// Identidad de servicio: token Bearer compartido solo entre servicios.
export function createServiceAuth(serviceToken) {
  const expected = digest(serviceToken);
  return function requireService(req, res, next) {
    const value = req.get('authorization');
    if (!value || !/^Bearer \S+$/i.test(value))
      throw new AppError(
        401,
        'NO_AUTENTICADO',
        'Se requiere identidad de servicio.',
      );
    if (!timingSafeEqual(digest(value.split(' ')[1]), expected))
      throw new AppError(
        403,
        'ACCESO_DENEGADO',
        'El servicio no esta autorizado.',
      );
    next();
  };
}