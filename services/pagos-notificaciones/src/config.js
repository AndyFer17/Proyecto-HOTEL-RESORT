import { z } from 'zod';

const url = z.string().url();
const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  PAGOS_PORT: z.coerce.number().int().min(1).max(65535).default(3004),
  PAGOS_DATABASE_URL: url.refine((v) => /^postgres(ql)?:/.test(v)),
  RESERVAS_URL: url,
  SERVICE_TOKEN: z.string().min(32),
  JWT_PUBLIC_KEY_BASE64: z.string().min(100),
  JWT_ISSUER: z.string().min(1).default('resort-clientes'),
  JWT_AUDIENCE: z.string().min(1).default('resort-api'),
  ALLOW_SIMULATED_PROVIDERS: z.enum(['true', 'false']).default('false'),
  NOTIFICATION_POLL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(1000),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Configuracion invalida: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const config = result.data;
  if (config.NODE_ENV === 'production')
    throw new Error(
      'Los proveedores simulados estan prohibidos en produccion.',
    );
  // Estos adaptadores no mueven dinero ni envian correos. Requieren opt-in incluso en desarrollo.
  if (config.ALLOW_SIMULATED_PROVIDERS !== 'true')
    throw new Error('Este prototipo requiere ALLOW_SIMULATED_PROVIDERS=true.');
  return config;
}
