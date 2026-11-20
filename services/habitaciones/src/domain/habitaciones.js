import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';

const MAX_NOCHES = 30;

function todayInLima(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
  }).format(now);
}

function nights(desde, hasta) {
  return Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) /
      86400000,
  );
}

// Reglas de negocio sobre el rango de fechas (error 422).
function checkRange({ desde, hasta }, now) {
  if (hasta <= desde)
    throw new AppError(
      422,
      'RANGO_INVALIDO',
      'La fecha hasta debe ser posterior a desde.',
    );
  if (desde < todayInLima(now))
    throw new AppError(
      422,
      'FECHA_PASADA',
      'La fecha desde no puede estar en el pasado.',
    );
  if (nights(desde, hasta) > MAX_NOCHES)
    throw new AppError(
      422,
      'ESTADIA_EXCESIVA',
      `La estadia maxima es de ${MAX_NOCHES} noches.`,
    );
}

export function createHabitacionesService(
  repository,
  { ttlSeconds, clock = () => new Date() },
) {
  return {
    async disponibilidad(query) {
      checkRange(query, clock());
      return { habitaciones: await repository.findAvailable(query) };
    },
    async obtener(id) {
      const room = await repository.findById(id);
      if (!room)
        throw new AppError(
          404,
          'HABITACION_NO_ENCONTRADA',
          'No se encontro la habitacion.',
        );
      return room;
    },
    async bloquear(key, input) {
      checkRange(input, clock());
      const huella = createHash('sha256')
        .update(
          JSON.stringify([
            input.reservaId,
            input.habitacionId,
            input.desde,
            input.hasta,
            input.personas,
          ]),
        )
        .digest('hex');
      return repository.createBloqueo({ key, huella, input, ttlSeconds });
    },
    async confirmar(id) {
      const result = await repository.confirmBloqueo(id);
      if (result === 'NO_ENCONTRADO')
        throw new AppError(
          404,
          'BLOQUEO_NO_ENCONTRADO',
          'No se encontro el bloqueo.',
        );
      if (result === 'NO_CONFIRMABLE')
        throw new AppError(
          409,
          'BLOQUEO_NO_CONFIRMABLE',
          'El bloqueo vencio o fue liberado.',
        );
      return { bloqueoId: id, estado: 'CONFIRMADO' };
    },
    async liberar(id) {
      const result = await repository.releaseBloqueo(id);
      if (result === 'NO_ENCONTRADO')
        throw new AppError(
          404,
          'BLOQUEO_NO_ENCONTRADO',
          'No se encontro el bloqueo.',
        );
    },
  };
}