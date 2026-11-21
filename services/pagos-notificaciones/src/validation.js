import { z } from 'zod';

export const idSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
export const amountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/)
  .refine((v) => v !== '0.00', { message: 'monto_positivo' });
export const cargoSchema = z
  .object({
    reservaId: idSchema,
    origen: z.enum(['HABITACION', 'RESTAURANTE', 'SPA_ACTIVIDADES']),
    origenId: idSchema,
    concepto: z.string().trim().min(1).max(200),
    monto: amountSchema,
    moneda: z.literal('PEN').default('PEN'),
  })
  .strict();
export const cargoUpdateSchema = z
  .object({
    monto: amountSchema,
    concepto: z.string().trim().min(1).max(200),
    operacionId: idSchema,
  })
  .strict();
export const paymentSchema = z
  .object({
    reservaId: idSchema,
    monto: amountSchema,
    metodo: z.literal('SIMULADO'),
    tokenPago: z.enum(['tok_aprobado', 'tok_rechazado']),
  })
  .strict();
export const notificationSchema = z
  .object({
    reservaId: idSchema,
    eventoId: idSchema,
    tipo: z.enum(['ReservaConfirmada', 'PagoConfirmado']),
  })
  .strict();
export const operationSchema = z.object({ operacionId: idSchema }).strict();
