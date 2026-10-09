# Servicio Clientes

Clientes es propietario del perfil y de las credenciales de los huéspedes. Expone registro, login y consulta del perfil propio. No administra habitaciones, reservas ni pagos.

## Flujo interno

La ruta valida el JSON y delega al caso de uso. El caso de uso aplica las reglas y solicita persistencia al repositorio. El repositorio ejecuta SQL parametrizado sobre `clientes.huespedes`. La aplicación recibe las dependencias al iniciar, lo que permite probar la misma lógica contra PostgreSQL y PGlite.

## Reglas

- Nombre de 2 a 120 caracteres, después de eliminar espacios externos.
- Correo válido de hasta 254 caracteres; se normaliza a minúsculas. La base impone unicidad, incluso con solicitudes concurrentes.
- Contraseña de 12 a 128 caracteres. No se almacena ni devuelve en texto plano.
- Teléfono opcional de 7 a 25 caracteres: dígitos, espacios, paréntesis, `+` inicial y guiones.
- El registro público solo crea `HUESPED`. Cualquier campo adicional, incluido `rol`, se rechaza.
- Solo el dueño indicado por `sub` del JWT consulta su perfil. Los roles de personal del informe quedan pendientes.
- Límite compartido de 30 POST de registro/login por IP cada 15 minutos. Es local a cada proceso.

## Contrato de ejemplo

`POST /api/v1/clientes`, con `Content-Type: application/json`:

```json
{
  "nombre": "Ana Demo",
  "email": "ana@example.com",
  "telefono": "+51 900 000 000",
  "password": "Ejemplo-academico-2026!"
}
```

Devuelve 201, cabecera `Location` y un objeto con `clienteId`, `nombre`, `email`, `telefono`, `rol`, `creadoEn`. Nunca incluye el hash.

`POST /api/v1/auth/login` recibe `email` y `password`. Devuelve `accessToken`, `tokenType: Bearer` y `expiresIn: 900`. Luego envía `Authorization: Bearer <accessToken>` al consultar `/api/v1/clientes/{id}`.

## Errores

```json
{
  "codigo": "EMAIL_DUPLICADO",
  "mensaje": "El correo ya está registrado.",
  "detalle": [],
  "traceId": "e434aa43-187e-4d83-8711-4bbcb642681a"
}
```

| HTTP | Situación                                                   |
| ---- | ----------------------------------------------------------- |
| 400  | Campos, UUID o JSON inválidos                               |
| 401  | Credenciales incorrectas, token ausente, inválido o vencido |
| 403  | Perfil ajeno                                                |
| 404  | Ruta inexistente o perfil propio inexistente                |
| 409  | Correo duplicado                                            |
| 413  | JSON de más de 16 KB                                        |
| 415  | Content-Type o codificación no admitidos                    |
| 429  | Exceso de intentos; consultar `Retry-After`                 |
| 500  | Error interno sin detalles sensibles                        |
| 503  | Readiness sin acceso a la persistencia                      |

Todas las respuestas de aplicación incluyen `X-Request-Id`; los errores incluyen el mismo `traceId`. Los logs contienen método, plantilla de ruta, estado y duración, sin cuerpos ni cabeceras de autenticación.

## Persistencia

`001_create_clientes.sql` crea el esquema, la tabla y el registro de migración. Es repetible para el arranque académico. Para futuras modificaciones se agregarán migraciones nuevas: no se editará una migración ya desplegada ni se confiará en `CREATE TABLE IF NOT EXISTS` para cambiar columnas.

La tabla utiliza UUID, un índice único de correo, restricciones de nombre/rol y `timestamptz`. `clienteId` es el identificador canónico; el `huespedId` mencionado en contratos de Reservas referenciará el mismo UUID. No se crearán claves foráneas físicas entre bases de servicios.

## Autenticación entre futuros servicios

Clientes firma JWT con su clave privada. `/.well-known/jwks.json` publica la clave pública. Habitaciones, Reservas y Pagos podrán verificar RS256, `iss`, `aud` y `exp` sin recibir la clave privada. Además deberán verificar permisos y propiedad de sus recursos.

Este JWT representa a un huésped. No autoriza por sí solo operaciones internas privilegiadas, como generar cargos o bloquear inventario: estas necesitarán identidad de servicio y permisos específicos. No existe aún un endpoint que permita a Reservas listar huéspedes o acceder arbitrariamente a perfiles.
