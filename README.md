# Hotel Resort Bahía Azul

Prototipo académico SOA con cuatro servicios de negocio: **Clientes, Habitaciones, Reservas y Pagos/Notificaciones**. Integra registro y autenticación, disponibilidad, reserva, cuenta de alojamiento, cobro simulado y avisos persistentes. Cada servicio ejecuta su proceso y conserva su propia base PostgreSQL.

La política de esta demostración es **reserva confirmada con cargo pendiente y cobro al finalizar**. No se exige un pago para crear la reserva. Las reservas pagadas no pueden cancelarse automáticamente: responden 409 y requieren gestión manual. El flujo con anticipos o reembolsos reales queda fuera del prototipo.

Los pagos y avisos son simulados, requieren `ALLOW_SIMULATED_PROVIDERS=true` y Pagos rechaza arrancar con `NODE_ENV=production`. El prototipo no mueve dinero ni envía correo/SMS real. Restaurante, Spa/Actividades y frontend siguen pendientes.

| Componente           | Función                                             | Acceso local            |
| -------------------- | --------------------------------------------------- | ----------------------- |
| Gateway Nginx        | Enrutamiento público; bloquea rutas internas        | `http://127.0.0.1:8080` |
| Clientes             | Registro, login RS256 y perfil propio               | `127.0.0.1:3001`        |
| Habitaciones         | Inventario, disponibilidad y bloqueos               | `127.0.0.1:3002`        |
| Reservas             | Estadías, idempotencia, coordinación y recuperación | `127.0.0.1:3003`        |
| Pagos/Notificaciones | Cuenta, cargos, pagos y avisos con reintento        | `127.0.0.1:3004`        |

## Ejecutar la demostración

Requisitos: Node.js 24, pnpm 11.25.0 y Docker con Compose que admita `up --wait`.

```sh
pnpm install --frozen-lockfile
pnpm setup:dev
docker compose config --quiet
docker compose up --build --wait --wait-timeout 180
pnpm smoke
```

`setup:dev` crea `.env` con claves RSA, token interno y contraseñas distintas de propietario y aplicación para cada base. No sobrescribe un archivo existente y no imprime secretos. Para regenerar explícitamente se puede ejecutar `pnpm setup:dev --force`; hacerlo no cambia contraseñas de volúmenes PostgreSQL existentes. Conserva las credenciales asociadas a los datos que necesites mantener.

Las migraciones se ejecutan con el propietario de cada base. Después se crea un usuario de aplicación con permisos de datos sobre su propio esquema, sin privilegios de superusuario ni creación de objetos. Los procesos API reciben únicamente su URL de aplicación; solo Clientes recibe la clave privada de firma. Las bases tienen redes separadas. Los puertos publicados se limitan a `127.0.0.1`.

```sh
docker compose ps
docker compose logs reservas pagos
docker compose down
```

`down` conserva los cuatro volúmenes. No uses `down -v` si necesitas conservar huéspedes, reservas, cuentas o pagos. Una base creada por versiones anteriores con otro usuario/contraseña requiere migración explícita o un entorno nuevo; el setup no transforma esos volúmenes.

El Gateway expone HTTP solo en loopback. Para acceso remoto debe agregarse terminación TLS con certificado válido en un proxy de confianza y controlar los puertos directos; no se ofrece HTTPS comercial en esta demo. El acceso directo a 3001–3004 permite depuración local y debe mantenerse privado. El Gateway bloquea `/api/v1/interno`, pero las llamadas entre servicios usan sus direcciones internas y token compartido.

## Probar con Postman

Importa [la colección de cuatro servicios](postman/Resort-Cuatro-Servicios.postman_collection.json) y ejecútala en orden con `baseUrl=http://127.0.0.1:8080`. Genera datos ficticios, guarda el JWT y los identificadores en variables y recorre registro → login → disponibilidad → reserva → cuenta → pago rechazado → pago aprobado → aviso → cancelación rechazada de una reserva pagada.

El pago usa `metodo=SIMULADO` y `tokenPago=tok_aprobado` o `tok_rechazado`. Son instrucciones del proveedor de prueba y no credenciales reales. Elimina `accessToken` y datos de ejecución antes de exportar una colección para compartirla. La colección antigua de Clientes se conserva para sus escenarios específicos.

Los contratos completos están en `services/*/openapi.json`. Las operaciones públicas principales son:

| Servicio             | Operaciones                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Clientes             | `POST /api/v1/clientes`, `POST /api/v1/auth/login`, `GET /api/v1/clientes/{id}`            |
| Habitaciones         | `GET /api/v1/habitaciones/disponibilidad`, `GET /api/v1/habitaciones/{id}`                 |
| Reservas             | `POST /api/v1/reservas`, `GET/PATCH/DELETE /api/v1/reservas/{id}`                          |
| Pagos/Notificaciones | `GET /api/v1/cuentas/{reservaId}`, `POST /api/v1/pagos`, `GET /api/v1/notificaciones/{id}` |

Reservas toma al huésped del `sub` del JWT; el cliente no envía `huespedId`. Las escrituras de reserva y pago necesitan `Idempotency-Key` UUID. Las respuestas monetarias son cadenas decimales en PEN. Los endpoints internos usan Bearer de servicio y nunca el token de un huésped.

## Desarrollo con Node.js y bases Docker

```sh
pnpm install --frozen-lockfile
pnpm setup:dev
docker compose up -d clientes-db habitaciones-db reservas-db pagos-db
pnpm db:migrate
pnpm db:migrate:habitaciones
pnpm db:migrate:reservas
pnpm db:migrate:pagos
```

Abre cuatro terminales y ejecuta respectivamente `pnpm start`, `pnpm start:habitaciones`, `pnpm start:reservas` y `pnpm start:pagos`. Sus variantes `dev`, `dev:habitaciones`, `dev:reservas` y `dev:pagos` activan watch. El lanzador filtra el entorno de cada proceso para que no herede claves privadas ni credenciales de otros dominios. Para ejecutar el smoke sin Gateway, configura `TEST_GATEWAY_URL` como cadena vacía. Por defecto prueba el Gateway y las cuatro APIs de Compose.

Las bases locales se publican en 5433–5436. Cada `*_MIGRATION_DATABASE_URL` usa propietario; `DATABASE_URL` y los otros `*_DATABASE_URL` usan roles de aplicación. `.env.example` documenta todas las variables sin proporcionar secretos válidos.

## Comprobaciones y evidencia

```sh
pnpm check
pnpm test:coverage
pnpm audit --prod --audit-level=high
```

`check` ejecuta ESLint, Prettier, validación de los cuatro OpenAPI y suites por servicio más integración. Las suites pueden usar PGlite sin servidor externo; CI configura cuatro bases PostgreSQL reales mediante `TEST_DATABASE_URL`, `TEST_HABITACIONES_DATABASE_URL`, `TEST_RESERVAS_DATABASE_URL` y `TEST_PAGOS_DATABASE_URL`.

GitHub Actions también construye e inicia Compose y ejecuta el smoke contra APIs y Gateway. La presencia de archivos y pruebas no acredita una ejecución aprobada: consulta el resultado de esta rama y [las pautas de evidencia](docs/pruebas.md). Solo apunta las suites a bases exclusivas de prueba.

## Organización y continuidad

```text
services/clientes/              Identidad y huéspedes
services/habitaciones/          Inventario y bloqueos
services/reservas/              Estadías y coordinación recuperable
services/pagos-notificaciones/  Cargos, cobros y avisos
services/shared/                Errores, HTTP, seguridad y utilidades comunes
test/integration/               Escenarios entre los cuatro servicios
scripts/                       Setup, migraciones, lanzadores, contratos y smoke
infra/                         Gateway local
postman/                       Colecciones de demostración
docs/                          Arquitectura, decisiones y evidencia
```

- [Arquitectura y consistencia](docs/arquitectura.md).
- [Decisiones y límites](docs/decisiones.md).
- [Pruebas y reproducción](docs/pruebas.md).
- [Guion de defensa](docs/entrega-y-defensa.md).
- [Colaboración](CONTRIBUTING.md).

El informe académico plantea seis servicios y recomienda comenzar por estos cuatro. La implementación debe comprobarse con persistencia, comunicación, escenarios de fallo y evidencia reproducible. Quedan fuera los proveedores reales, reembolsos, cuentas de empleados, frontend y las extensiones de Restaurante y Spa/Actividades. No se presenta como plataforma lista para operación comercial.
