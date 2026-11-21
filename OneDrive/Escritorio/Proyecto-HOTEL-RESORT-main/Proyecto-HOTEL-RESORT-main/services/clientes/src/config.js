import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:/.test(v)),
  JWT_PRIVATE_KEY_BASE64: z.string().min(100),
  JWT_PUBLIC_KEY_BASE64: z.string().min(100),
  JWT_ISSUER: z.string().min(1).default('resort-clientes'),
  JWT_AUDIENCE: z.string().min(1).default('resort-api'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    // No imprimir valores de configuración: pueden contener secretos.
    throw new Error(
      `Configuración inválida: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return result.data;
}
