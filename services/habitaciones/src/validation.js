import { z } from 'zod';
import { AppError } from './errors.js';

function isRealDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate, { message: 'fecha_inexistente' });
const personas = z.coerce.number().int().min(1).max(20);

export const disponibilidadSchema = z
  .object({ desde: fecha, hasta: fecha, personas })
  .strict();
export const bloqueoSchema = z
  .object({
    reservaId: z.string().uuid(),
    habitacionId: z.string().uuid(),
    desde: fecha,
    hasta: fecha,
    personas: z.number().int().min(1).max(20),
  })
  .strict();
export const idSchema = z.string().uuid();
export const cambioSchema = z
  .object({
    desde: fecha,
    hasta: fecha,
    personas: z.number().int().min(1).max(20),
  })
  .strict();
export const estadoSchema = z
  .object({ estado: z.enum(['EN_SERVICIO', 'LIMPIEZA', 'MANTENIMIENTO']) })
  .strict();
export const idempotencySchema = z.string().uuid();

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
