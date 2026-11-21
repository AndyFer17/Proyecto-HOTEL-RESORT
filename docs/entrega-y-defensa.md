# Entrega y defensa del prototipo SOA

## Relación con el informe académico

El apartado 13 del informe propone un mínimo de cuatro servicios funcionales con APIs, persistencia, comunicación entre servicios, pruebas Postman y repositorio Git. La rúbrica oficial y la fecha deben confirmarse con el material del curso; este documento no las sustituye.

| Aspecto         | Evidencia disponible en el código                      | Qué debe mostrarse en una ejecución              |
| --------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Cuatro dominios | Clientes, Habitaciones, Reservas, Pagos/Notificaciones | Cuatro APIs activas                              |
| Datos propios   | Migraciones y roles separados por base                 | Datos conservados tras reinicio                  |
| Contratos       | Cuatro OpenAPI y colección Postman                     | Peticiones y respuestas acordes                  |
| Integración     | Reservas coordina inventario, cargos y avisos          | Reserva y cuenta de extremo a extremo            |
| Consistencia    | Bloqueos, idempotencia, fases y outbox persistentes    | Concurrencia, reintento y recuperación           |
| Seguridad       | JWT público/privado, propietario y Bearer interno      | Rechazos 401/403 y rutas internas ocultas        |
| Cobro y avisos  | Proveedores simulados habilitados explícitamente       | Rechazo, aprobación, saldo y aviso               |
| Git y calidad   | Lockfile, suites y CI                                  | Commit/PR y resultado real de las comprobaciones |

## Guion de demostración

1. Explicar el problema de integración y mostrar el mapa de cuatro servicios y bases separadas.
2. Ejecutar Compose y mostrar readiness; identificar el Gateway como infraestructura, no como quinto servicio de negocio.
3. Ejecutar la colección: huésped → login → disponibilidad → reserva → cuenta.
4. Mostrar que la identidad proviene del JWT y el precio de Habitaciones, no de datos arbitrarios del navegador.
5. Repetir la misma operación con su clave y comprobar que no aparecen duplicados.
6. Simular pago rechazado y aprobado; mostrar saldo y aviso persistente sin afirmar que se movió dinero real.
7. Intentar cancelar la reserva pagada: 409. Mostrar una cancelación sin pago que anule el cargo y libere la habitación.
8. Mostrar pruebas de concurrencia, recuperación y permisos, junto al resultado real de `pnpm check` y Actions.

## Preguntas para practicar

**¿Por qué son servicios separados?** Tienen responsabilidad, contrato HTTP y propiedad de datos propias. Compartir utilidades técnicas y repositorio Git no permite escribir en las tablas de otro dominio.

**¿Cómo evitan dos ocupaciones simultáneas?** Habitaciones aplica control transaccional y exclusión de rangos de PostgreSQL; no confía solamente en consultar disponibilidad.

**¿Qué ocurre si una dependencia falla?** Reservas conserva la operación y su fase para recuperación. Una respuesta 202 no se presenta como confirmación terminada. Reintentar no debe duplicar bloqueos ni cargos.

**¿Qué pasa si falla un aviso?** La reserva confirmada se conserva; el outbox y el aviso persistido permiten reintentar. En esta demo el proveedor es simulado.

**¿Por qué no cancelar una reserva pagada automáticamente?** No hay integración de reembolso real. Se rechaza con 409 para no liberar inventario y simular devolución de dinero sin soporte contable.

**¿Está listo para producción?** No. Pagos prohíbe los proveedores simulados en producción. Se necesitan pasarela y avisos reales, TLS, secretos administrados, revisión de permisos, backups y operación monitorizada.

## Continuidad

El trabajo posterior incluye proveedores reales y su conciliación, gestión explícita de anticipos/reembolsos, empleados y flujos de recepción, frontend, Restaurante y Spa/Actividades con sus cargos. El reparto de módulos no se deduce de la autoría de commits: debe acordarse con el equipo. Todos deben poder explicar el flujo completo durante la defensa.
