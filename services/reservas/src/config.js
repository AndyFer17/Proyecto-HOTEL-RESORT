import { z } from 'zod';

const serviceUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  });

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  RESERVAS_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  RESERVAS_DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:/.test(v)),
  HABITACIONES_URL: serviceUrl,
  PAGOS_URL: serviceUrl,
  CLIENTES_URL: serviceUrl,
  SERVICE_TOKEN: z.string().min(32),
  JWT_PUBLIC_KEY_BASE64: z.string().min(100),
  JWT_ISSUER: z.string().default('resort-clientes'),
  JWT_AUDIENCE: z.string().default('resort-api'),
  DEPENDENCY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10000)
    .default(3000),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Configuracion invalida: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return result.data;
}
