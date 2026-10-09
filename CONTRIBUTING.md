# Trabajo en equipo

1. Clona el repositorio y ejecuta `pnpm install --frozen-lockfile`.
2. Crea una rama con propósito concreto: `feat/habitaciones-disponibilidad`, `fix/clientes-validacion` o `docs/contratos`.
3. Antes de implementar un servicio pendiente, acuerda su OpenAPI y propiedad de datos.
4. Agrega pruebas de la regla o integración que cambiaste; ejecuta `pnpm check`.
5. Crea un pull request y solicita revisión de otro integrante. No subir `.env`, tokens, capturas con datos reales ni `node_modules`.
6. Describe qué funciona, qué se probó y qué sigue pendiente. Nunca marcar un diseño como implementado.

Convención de commits: `feat(clientes): ...`, `fix(reservas): ...`, `test(clientes): ...`, `docs: ...`. Las migraciones nuevas se agregan como archivos versionados; no se modifica una ya aplicada.

No se agregan colaboradores ni se configura protección de ramas automáticamente. El propietario puede requerir revisión y CI antes de fusionar cuando el equipo comience a trabajar.
