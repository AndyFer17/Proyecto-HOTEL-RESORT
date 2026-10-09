# Proyecto Hotel Resort SOA

Plataforma académica para el Hotel Resort Bahía Azul. El objetivo es integrar huéspedes, habitaciones, reservas y pagos mediante servicios con responsabilidades y contratos separados. En una fase posterior se incorporarán restaurante y spa/actividades para consolidar los consumos de la estadía.

**Estado de esta entrega: un servicio implementado, Clientes; tres servicios diseñados, todavía sin implementación.** Esta entrega es un avance de la semana 15 y no cumple aún el mínimo grupal de cuatro servicios funcionales. No hay interfaz web ni integración extremo a extremo en esta versión.

| Servicio               | Estado                       | Responsabilidad                                     | Puerto previsto |
| ---------------------- | ---------------------------- | --------------------------------------------------- | --------------- |
| Clientes               | Implementado y probado       | Registro, autenticación y perfil propio del huésped | 3001            |
| Habitaciones           | Diseño y contrato preliminar | Inventario, disponibilidad por fechas y bloqueos    | 3002            |
| Reservas               | Diseño y contrato preliminar | Ciclo de vida de la estadía y coordinación          | 3003            |
| Pagos / Notificaciones | Diseño y contrato preliminar | Cuenta consolidada, cobros y avisos                 | 3004            |

## Qué puedes demostrar ahora

1. Registrar un huésped y guardarlo en PostgreSQL.
2. Iniciar sesión y recibir un JWT firmado con RS256, válido por 15 minutos.
3. Consultar el perfil propio usando el token.
4. Rechazar un correo repetido, datos inválidos y consultas a perfiles ajenos.
5. Mostrar la separación de rutas, negocio y persistencia, las pruebas y el contrato OpenAPI.

## Requisitos

- Node.js 24 y pnpm 11.25.0 (`npm install --global pnpm@11.25.0`).
- Docker con Compose para el inicio recomendado. Como alternativa, PostgreSQL 17 instalado por separado.
- Postman es opcional. Las pruebas automatizadas usan el cliente HTTP de Node.js.

## Inicio recomendado con Docker

Desde la raíz del repositorio:

```sh
pnpm install --frozen-lockfile
pnpm setup:dev
docker compose up --build -d
docker compose ps
```

`setup:dev` crea `.env` con una contraseña local aleatoria y un par de claves RSA. No sobrescribe un `.env` existente. Compose espera a PostgreSQL, ejecuta la migración y levanta Clientes. Abre `http://localhost:3001/health/ready`: debe responder `200` con `estado: OK`.

```sh
docker compose logs clientes
docker compose down
```

`down` conserva el volumen de datos. No borres el volumen si necesitas conservar huéspedes. Cambiar la contraseña en `.env` no cambia la contraseña de un volumen PostgreSQL ya inicializado. Conserva tu `.env` local durante el desarrollo.

## Alternativa con Node.js local

```sh
pnpm install --frozen-lockfile
pnpm setup:dev
docker compose up -d clientes-db
pnpm db:migrate
pnpm start
```

Si usas PostgreSQL instalado por separado, crea una base exclusiva para Clientes y modifica `DATABASE_URL` en `.env` antes de ejecutar la migración. La configuración de ejemplo usa `127.0.0.1:5433`. `pnpm dev` reinicia el servidor al editar código.

## Demostración con Postman

Importa [la colección](postman/Resort-Clientes.postman_collection.json). Usa `baseUrl=http://localhost:3001`. Ejecuta las solicitudes en orden o con Collection Runner. El script inicial genera un correo ficticio distinto; los siguientes guardan `clienteId` y `accessToken` como variables de colección.

1. **Disponibilidad del servicio**: respuesta 200.
2. **Registrar huésped**: respuesta 201 con `clienteId`.
3. **Iniciar sesión**: respuesta 200 con `accessToken`.
4. **Consultar mi perfil**: respuesta 200.
5. **Rechazar correo duplicado**: respuesta 409.
6. **Rechazar consulta sin token**: respuesta 401.
7. **Rechazar perfil ajeno**: respuesta 403.

Solo usa datos ficticios. Elimina el token de las variables antes de exportar una colección para compartirla. El contrato completo está en [Clientes OpenAPI](services/clientes/openapi.json).

| Método | Ruta                     | Acceso                             |
| ------ | ------------------------ | ---------------------------------- |
| POST   | `/api/v1/clientes`       | Público, registro limitado por IP  |
| POST   | `/api/v1/auth/login`     | Público, intentos limitados por IP |
| GET    | `/api/v1/clientes/{id}`  | JWT y propietario del perfil       |
| GET    | `/.well-known/jwks.json` | Público, únicamente clave pública  |
| GET    | `/health/live`           | Proceso activo                     |
| GET    | `/health/ready`          | Base y tabla disponibles           |

## Calidad y pruebas

```sh
pnpm check
pnpm test:coverage
pnpm audit --prod --audit-level=high
```

`pnpm check` ejecuta ESLint, Prettier, validación de los cuatro contratos OpenAPI y 16 pruebas. Sin `TEST_DATABASE_URL`, usa PGlite (PostgreSQL embebido) para ejecutar SQL real sin instalar un servidor. Incluye una prueba de persistencia en disco al cerrar y reabrir la base.

Para probar contra PostgreSQL por TCP, configura `TEST_DATABASE_URL` con una base exclusiva de pruebas. La suite crea tablas y registros ficticios; no debe ejecutarse sobre una base de producción. El workflow de GitHub Actions usa PostgreSQL 17 y no necesita secretos del repositorio.

## Organización

```text
.github/                 CI y plantilla de pull request
docs/                    Arquitectura, decisiones, pruebas y guía de defensa
postman/                 Colección ejecutable
scripts/                 Configuración local y validación de contratos
services/
  clientes/              Único servicio funcional
    migrations/          Esquema SQL versionado
    src/
      domain/            Casos de uso
      repositories/      Consultas SQL parametrizadas
      security/          Contraseñas y JWT
      app.js             Rutas y middleware
      server.js          Inicio y apagado
    test/                Pruebas de HTTP, seguridad y persistencia
  habitaciones/          README y OpenAPI preliminar
  reservas/              README y OpenAPI preliminar
  pagos-notificaciones/  README y OpenAPI preliminar
```

## Documentación del equipo

- [Arquitectura e integración prevista](docs/arquitectura.md).
- [Decisiones y límites de seguridad](docs/decisiones.md).
- [Servicio Clientes explicado](services/clientes/README.md).
- [Evidencias de pruebas](docs/pruebas.md).
- [Guion para la exposición y próximos pasos](docs/entrega-y-defensa.md).
- [Cómo colaborar](CONTRIBUTING.md).

## Alcance y pendientes

No se implementaron todavía Habitaciones, Reservas, Pagos/Notificaciones, API Gateway, cuentas de empleados, correo real, pasarela de pagos ni frontend. Los esquemas OpenAPI de esos tres servicios son propuestas para acordar en equipo. Docker y CI se incluyen para reproducibilidad; consulta el registro de pruebas para distinguir qué se verificó realmente.

El prototipo local usa HTTP únicamente en loopback. Un despliegue externo requiere HTTPS, gestión de secretos, rotación de claves, límites distribuidos, copias de seguridad y revisión de permisos. No es una plataforma lista para operación comercial.
