import { z } from 'zod';
import { AppError } from '../../shared/errors.js';

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  });
export const idSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const crearSchema = z
  .object({
    habitacionId: idSchema,
    desde: fecha,
    hasta: fecha,
    personas: z.number().int().min(1).max(20),
  })
  .strict();
export const modificarSchema = z
  .object({
    desde: fecha.optional(),
    hasta: fecha.optional(),
    personas: z.number().int().min(1).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export function validateRange({ desde, hasta }, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
  }).format(now);
  if (
    hasta <= desde ||
    desde < today ||
    (Date.parse(hasta) - Date.parse(desde)) / 86400000 > 30
  )
    throw new AppError(
      422,
      'FECHAS_INVALIDAS',
      'Usa fechas futuras y una estadia de 1 a 30 noches.',
    );
}
