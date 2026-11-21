# Decisiones técnicas y límites

## ADR 001 — Node.js, Express y PostgreSQL

Se mantiene la tecnología elegida en el informe: Node.js 24, Express 5, REST/JSON y PostgreSQL. Las rutas delegan a casos de uso; los repositorios concentran SQL parametrizado. El lockfile fija las dependencias resueltas. No se agregan un ORM, un broker ni un frontend antes de que el primer servicio esté comprobado.

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
- El usuario PostgreSQL local es el inicializador del contenedor. En producción separar propietario de migraciones y usuario de aplicación con permisos mínimos.
- No hay verificación de correo, MFA, cuentas de empleados, auditoría persistente, backups ni alertas. Son ampliaciones pendientes.

## ADR 005 — Pruebas portables y CI

Las pruebas HTTP atraviesan la aplicación real. PGlite ejecuta las migraciones y consultas en un PostgreSQL embebido; no reemplaza una prueba de red/pool contra el servidor. Por eso GitHub Actions configura PostgreSQL 17 y `TEST_DATABASE_URL`. La prueba adicional de disco comprueba persistencia entre aperturas.

El workflow de CI valida estilo, contratos, pruebas, dependencias de producción y sintaxis Compose. No despliega el sistema ni garantiza por sí solo seguridad de producción.
