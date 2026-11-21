# Decisiones técnicas y límites

## ADR 001 — Node.js, Express y PostgreSQL

Se mantiene la tecnología elegida en el informe: Node.js 24, Express 5, REST/JSON y PostgreSQL. Las rutas delegan a casos de uso; los repositorios concentran SQL parametrizado. El lockfile fija las dependencias resueltas. No se agregan un ORM, un broker ni un frontend antes de que el flujo base de cuatro servicios esté comprobado.

Referencias: [Node.js](https://nodejs.org/en/about/previous-releases), [errores asíncronos de Express 5](https://expressjs.com/en/5x/guide/error-handling/), [consultas parametrizadas de node-postgres](https://node-postgres.com/features/queries).

## ADR 002 — JWT asimétrico

RS256 permite que los otros servicios verifiquen tokens sin poseer la clave que los firma. Los tokens duran 900 segundos y no contienen correo ni nombre. No hay refresh tokens, revocación inmediata ni recuperación de contraseñas; al caducar, el huésped vuelve a iniciar sesión. La rotación futura debe mantener temporalmente claves públicas anteriores y usar `kid`.

Los secretos se generan localmente y `.env` está excluido de Git y del contexto Docker. En producción deben suministrarse mediante un gestor de secretos. El endpoint JWKS solo devuelve material público. Para acceder fuera del equipo local se necesita HTTPS.

## ADR 003 — Hash de contraseñas

Se usa `scrypt` asíncrono de Node, sal aleatoria de 16 bytes, N=32768, r=8, p=3 y salida de 64 bytes. La versión se almacena junto al hash para permitir migraciones. La comparación usa tiempo constante. Un correo inexistente también ejecuta la derivación para reducir diferencias de tiempo.

El registro informa 409 si el correo existe; esto permite enumeración de correos en el endpoint público. Es una decisión académica visible, mitigada parcialmente con rate limiting, que debe revisarse antes de exposición pública. El login no distingue entre correo desconocido y contraseña incorrecta.

## ADR 004 — Alcance de seguridad y operación

- La validación rechaza campos extra para evitar asignación de roles desde el cliente.
- SQL usa parámetros; la unicidad está en la base y resiste altas concurrentes.
- Helmet agrega cabeceras; las respuestas llevan `Cache-Control: no-store`.
- El cuerpo JSON está limitado a 16 KB; login y registro tienen un límite por IP compartido.
- El limitador usa memoria por proceso; no coordina réplicas ni mantiene límites tras reinicios. Una instalación distribuida necesita almacenamiento compartido.
- No se habilita `trust proxy` automáticamente. Si se agrega un proxy, configurar solo los saltos confiables para conservar límites por IP correctos.
- No se habilita CORS para un frontend inexistente. Al construirlo, definir explícitamente orígenes permitidos.
- El contenedor de aplicación corre como usuario `node`, con sistema de archivos de solo lectura y sin privilegios nuevos.
- Compose separa propietario de migraciones y rol de aplicación en cada una de cuatro bases. Solo el migrador recibe credenciales del propietario; el runtime recibe permisos de datos sobre su esquema y no privilegios de superusuario ni DDL.
- Pagos conserva auditoría persistente de cargos, pagos, bloqueos de cuenta y avisos. No hay un sistema centralizado e inmutable de auditoría de todos los servicios; esa ampliación, verificación de correo, MFA, cuentas de empleados, backups y alertas siguen pendientes.

## ADR 005 — Pruebas portables y CI

Las pruebas HTTP atraviesan la aplicación real. PGlite ejecuta las migraciones y consultas en un PostgreSQL embebido; no reemplaza una prueba de red/pool contra el servidor. Por eso GitHub Actions configura cuatro bases PostgreSQL 17 y las variables `TEST_DATABASE_URL`, `TEST_HABITACIONES_DATABASE_URL`, `TEST_RESERVAS_DATABASE_URL` y `TEST_PAGOS_DATABASE_URL`. La prueba adicional de disco comprueba persistencia entre aperturas.

El workflow de CI valida estilo, contratos, pruebas, dependencias de producción y sintaxis Compose. No despliega el sistema ni garantiza por sí solo seguridad de producción.

## ADR 006 — Reserva sin anticipo y simuladores explícitos

Para la demo se confirma la reserva con cargo pendiente y se cobra al finalizar. El huésped se identifica desde el JWT; Habitaciones calcula el precio y Pagos consolida el cargo por origen único. Un pago rechazado no reduce saldo. Los pagos usan `SIMULADO`, `tok_aprobado` o `tok_rechazado`; no representan una transacción externa.

Pagos requiere `ALLOW_SIMULATED_PROVIDERS=true` y rechaza arrancar en producción. Las notificaciones simuladas se guardan con estado e intentos; su entrega se reintenta sin cancelar una reserva confirmada. La cancelación pagada responde 409 y no efectúa reembolso automático. Anticipos, conciliación y reembolsos reales requieren otro flujo explícito.

## ADR 007 — Operaciones recuperables y outbox

Reservas persiste operación, fase e idempotencia antes de coordinar HTTP. Los workers pueden reintentar después de reiniciar y la API devuelve 202 mientras falta completar una coordinación. Una llamada que agota timeout puede haber terminado: no se la trata como inexistente ni se duplica con otra identidad.

La confirmación y su evento se conservan en la misma transacción local. La entrega del aviso se realiza fuera de esa transacción con una clave estable. El coordinador de Reservas puede recuperarse sin mantener una transacción SQL abierta durante sus llamadas HTTP; no promete entrega exactamente una vez a un proveedor real. Pagos sí revalida por API el estado de la reserva bajo el lock local de la cuenta antes de un pago nuevo, con timeout acotado; ese lock no es una transacción distribuida y una dependencia caída revierte el intento local. El replay de un resultado ya persistido no necesita esa consulta remota.

## ADR 008 — Gateway y entorno local

Nginx enruta las APIs públicas y oculta rutas internas. Todos los puertos publicados son loopback y las redes de base se separan por dominio. La demo usa HTTP local; TLS y certificados se terminan en un proxy de confianza antes de cualquier exposición remota. No se configura `trust proxy` indiscriminadamente: el limitador de Clientes detrás del Gateway comparte la IP del proxy y sigue siendo una limitación académica en memoria.

Se utilizan bridges independientes con publicación en loopback, en lugar de redes marcadas `internal`, para permitir smoke y desarrollo desde el host. Se conserva la separación de dominios, sin prometer bloqueo de salida a Internet. Referencia: [redes de Docker Compose](https://docs.docker.com/compose/how-tos/networking/#internal-networks).

El lanzador local filtra el entorno por servicio. Los verificadores no heredan la clave de firma ni secretos de los otros dominios; Compose también entrega credenciales explícitas por proceso. `.env` no se incorpora a las imágenes y el setup nunca imprime sus valores.
