# Trabajo en equipo

1. Instala dependencias con `pnpm install --frozen-lockfile` y genera configuración local con `pnpm setup:dev`.
2. Crea una rama con propósito concreto, por ejemplo `codex/reservas-recuperacion` o `fix/pagos-idempotencia`.
3. Conserva contratos, propiedad de datos y política de cobro de la demo. Un cambio de dominio no accede a tablas ajenas.
4. Agrega pruebas cuando cambies una regla, una autorización o un comportamiento de integración. Ejecuta `pnpm check`.
5. Si cambias integración o infraestructura, ejecuta Compose y `pnpm smoke` cuando Docker esté disponible, y separa los resultados locales de los de CI.
6. Abre un pull request que explique comportamiento, validación y límites pendientes. No subas `.env`, claves, JWT, datos reales ni `node_modules`.

Convención de commits: `feat(reservas): ...`, `fix(pagos): ...`, `test(integracion): ...`, `docs: ...`. No modificar una migración ya aplicada; agregar una nueva y actualizar las concesiones para el rol de aplicación mediante el migrador.

Las APIs se inician con roles SQL de aplicación, no propietarios. Solo Clientes recibe clave privada JWT. Las rutas internas no son endpoints públicos y requieren identidad de servicio. Los proveedores simulados necesitan opt-in y quedan prohibidos en producción.

El setup conserva `.env` existente. `--force` regenera secretos solo de manera explícita y no cambia credenciales guardadas en volúmenes ya inicializados. No borrar volúmenes para resolver fallos sin revisar qué datos se perderían.

Documenta lo implementado, lo probado y lo pendiente como estados distintos. Nunca presentar un diagrama o la existencia de un workflow como prueba de ejecución. No se modifica protección de ramas ni se agregan colaboradores automáticamente.
