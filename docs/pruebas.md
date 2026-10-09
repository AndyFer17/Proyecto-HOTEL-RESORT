# Evidencia de validación

## Verificación local del avance

Validado el 9 de octubre de 2026 con Node.js 24 y dependencias fijadas en `pnpm-lock.yaml`:

| Comprobación               | Resultado local                                        |
| -------------------------- | ------------------------------------------------------ |
| ESLint                     | Sin errores                                            |
| Prettier                   | Formato verificado                                     |
| OpenAPI                    | Cuatro contratos válidos                               |
| Suite funcional            | 16 pruebas aprobadas, 0 fallidas                       |
| Dependencias de producción | Auditoría sin vulnerabilidades conocidas al ejecutarla |

Las pruebas locales ejecutan la aplicación Express mediante HTTP y el SQL de migración/repositorio contra PGlite. Incluyen persistencia en disco, reinicio de la base, correo duplicado concurrente, permisos de perfil, expiración y alteración de JWT, validación, límites, caída de base y ausencia de secretos en logs.

No había Docker ni un servidor PostgreSQL instalado en el entorno local de preparación. Por eso el arranque del contenedor y la conexión PostgreSQL por TCP se verifican mediante el workflow de GitHub Actions. El resultado vigente debe consultarse en la pestaña Actions del repositorio; la existencia del YAML no demuestra una ejecución exitosa.

## Verificación en GitHub Actions

El workflow utiliza PostgreSQL 17, ejecuta `pnpm check` con `TEST_DATABASE_URL`, audita dependencias y construye/arranca Compose. Después hace una prueba HTTP de registro → login → perfil sobre el contenedor. No se utilizan claves de producción: se generan claves temporales durante cada ejecución.

## Reproducir

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod --audit-level=high
```

Para verificar el sistema levantado:

```sh
node scripts/smoke.mjs
```

El smoke test agrega un huésped ficticio nuevo y no elimina datos. Solo apunta a un entorno de desarrollo o pruebas. Por defecto usa `http://127.0.0.1:3001`; se puede cambiar con `TEST_BASE_URL`.

Las capturas para la exposición deben obtenerse de una ejecución propia: respuesta de registro, login sin revelar el token completo, perfil, conflictos y resultado de pruebas. No se incluyen capturas inventadas.
