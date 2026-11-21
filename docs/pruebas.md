# Pruebas y evidencia de la demostración

## Verificación local del 21 de noviembre de 2026

`pnpm check` terminó correctamente con **79 pruebas aprobadas**, cero fallos y cero omitidas: Clientes 16, Habitaciones 20, Reservas 14, Pagos/Notificaciones 19 e integración/seguridad común 10. También pasaron ESLint, Prettier y la validación de los cuatro OpenAPI. Esta ejecución utilizó Node.js 24 y PGlite en Windows, con llamadas HTTP reales entre los cuatro dominios en la suite de integración.

`pnpm audit --prod --audit-level=high` terminó sin vulnerabilidades conocidas después de actualizar Express, express-rate-limit, jose, Zod y sus dependencias transitivas. Esto describe el resultado de la auditoría en esa fecha; no equivale a una garantía de ausencia de vulnerabilidades.

El propio script `scripts/smoke.mjs` también pasó con cuatro aplicaciones HTTP y workers sobre PGlite, desactivando el Gateway en ese entorno. Las pruebas de Docker, Nginx, roles de ejecución y PostgreSQL por TCP se verifican por separado en GitHub Actions. Consultar la ejecución del commit que se entregue.

## Qué debe verificarse

El repositorio contiene suites por servicio, integración HTTP y un smoke sobre procesos activos. Los escenarios definidos y la existencia de CI no son prueba de una ejecución exitosa. Al entregar, registrar fecha, commit y resultados reales del entorno utilizado.

Validación local del 21 de noviembre de 2026: el script smoke completó su flujo sobre cuatro aplicaciones HTTP reales con cuatro bases PGlite y sus workers. También se verificaron sintaxis YAML, separación de credenciales y redes declaradas, scripts de la colección Postman y setup idempotente con regeneración explícita. Estas comprobaciones no ejecutaron Nginx, Docker Compose ni PostgreSQL por TCP, que requieren una ejecución separada de Docker/CI. El resultado global de las suites y la auditoría debe registrarse desde la comprobación final de la rama.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
pnpm audit --prod --audit-level=high
```

`pnpm check` ejecuta ESLint, Prettier, cuatro contratos OpenAPI y las pruebas. PGlite permite ejecutar SQL sin servidor. Para probar pool y red contra PostgreSQL real, usar bases exclusivas con `TEST_DATABASE_URL`, `TEST_HABITACIONES_DATABASE_URL`, `TEST_RESERVAS_DATABASE_URL` y `TEST_PAGOS_DATABASE_URL`. No apuntar a datos de desarrollo que se necesite conservar ni a producción.

## Escenarios relevantes

| Área         | Comprobación                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Clientes     | Registro persistente, login, JWT inválido/expirado, propiedad, correo duplicado y validación           |
| Habitaciones | Disponibilidad, estado operativo, capacidad, rangos, bloqueos, expiración, concurrencia e idempotencia |
| Reservas     | Crear/consultar/modificar/cancelar propias, fases persistentes, dependencias y recuperación            |
| Pagos        | Cuenta propia, origen único, rechazo/aprobación simulados, pago idempotente y saldo                    |
| Avisos       | Registro persistente, reintentos y autorización de consulta                                            |
| Integración  | Flujo entre los cuatro dominios sin acceso directo a tablas ajenas                                     |
| Gateway      | Enrutamiento público y rechazo de rutas internas                                                       |

Las pruebas usan datos ficticios. Las cantidades de pruebas cambian con el código; informar el conteo del comando ejecutado en lugar de conservar un número histórico del avance de Clientes.

## Compose y smoke

```sh
pnpm setup:dev
docker compose config --quiet
docker compose up --build --wait --wait-timeout 180
pnpm smoke
docker compose down
```

El smoke comprueba readiness de las cuatro APIs y del Gateway; luego registra un huésped, inicia sesión, consulta perfil y disponibilidad, crea una reserva, repite su clave, consulta la cuenta, rechaza un pago, aprueba otro, repite el pago, espera el aviso, rechaza cancelar una reserva pagada y cancela una segunda sin pago. También verifica acceso a cuenta sin token y bloqueo de una ruta interna desde el Gateway.

El script agrega datos ficticios y conserva la reserva pagada para trazabilidad. Elige fechas futuras aleatorias para reducir colisiones entre ejecuciones. Los avisos pueden tardar algunos ciclos del worker. `TEST_GATEWAY_URL` usa `http://127.0.0.1:8080` por defecto; una cadena vacía permite probar cuatro procesos locales sin Gateway. Las variables `TEST_BASE_URL`, `TEST_HABITACIONES_URL`, `TEST_RESERVAS_URL` y `TEST_PAGOS_URL` cambian las URLs directas.

## GitHub Actions

El job `soa` usa PostgreSQL 17 para cada servicio, ejecuta comprobaciones y auditoría, genera secretos efímeros y construye Compose. Los PostgreSQL de pruebas usan puertos 5533–5536; los de Compose usan 5433–5436, evitando conflictos. Después ejecuta el smoke y recoge logs al fallar. La limpieza solo se intenta si se creó la configuración local, evitando errores secundarios por variables ausentes.

La configuración de CI no requiere secretos del repositorio y no despliega a un entorno público. En un equipo sin Docker no puede acreditarse localmente ni la construcción ni el arranque de Compose: esa comprobación debe reportarse por separado de las pruebas con PGlite.

## Evidencia para la defensa

Conservar salida de comprobaciones, commit/PR, enlace a Actions y capturas propias de reserva, cuenta, pago y aviso. Mostrar fallos controlados y al menos una recuperación con persistencia. No compartir `.env`, JWT completos, contraseñas ni datos reales. Si una comprobación no se ejecutó, registrarla como pendiente; no convertir archivos de configuración en evidencia de éxito.
