import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  HABITACIONES_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3002),
  HABITACIONES_DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:/.test(v)),
  SERVICE_TOKEN: z.string().min(32),
  BLOQUEO_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    // No imprimir valores: pueden contener secretos.
    throw new Error(
      `Configuracion invalida: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return result.data;
}