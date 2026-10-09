import { z } from 'zod';
import { AppError } from './errors.js';

const email = z.string().trim().toLowerCase().email().max(254);
export const registrationSchema = z
  .object({
    nombre: z.string().trim().min(2).max(120),
    email,
    telefono: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,25}$/)
      .optional(),
    password: z.string().min(12).max(128),
  })
  .strict();
export const loginSchema = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();
export const idSchema = z.string().uuid();

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
