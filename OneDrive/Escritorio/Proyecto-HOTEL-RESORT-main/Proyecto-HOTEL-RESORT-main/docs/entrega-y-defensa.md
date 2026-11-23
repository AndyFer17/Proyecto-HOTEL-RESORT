# Entrega y defensa del avance

## Relación con la rúbrica

| Requisito                     | Evidencia de esta versión                               | Pendiente                                          |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Servicios y responsabilidades | Clientes funcional y tres diseños separados             | Implementar los otros tres                         |
| Contratos                     | Cuatro OpenAPI, uno implementado                        | Acordar y cumplir contratos preliminares           |
| REST y persistencia           | Registro/login/perfil en Clientes, migración PostgreSQL | Persistencia de los otros dominios                 |
| Seguridad básica              | JWT, perfil propio, hash, validaciones y límites        | Roles de empleados y autenticación entre servicios |
| Pruebas                       | Suite automatizada y colección Postman                  | Flujo entre dos o más servicios                    |
| Git y documentación           | Código, lockfile, README, arquitectura, CI              | Historial del trabajo de los demás integrantes     |
| Cuatro servicios funcionales  | Uno de cuatro                                           | No cumple todavía el entregable 3 completo         |

## Guion sugerido de exposición

1. **Problema:** las áreas del hotel necesitan compartir operaciones de la estadía sin mezclar responsabilidades.
2. **Arquitectura:** mostrar el mapa y distinguir lo implementado de lo diseñado.
3. **Demostración:** ejecutar la colección Postman y mostrar el registro persistido, login y perfil propio.
4. **Validación:** intentar correo repetido, acceso sin token y perfil ajeno.
5. **Código:** explicar ruta → caso de uso → repositorio; mostrar restricción única y JWT.
6. **Pruebas:** ejecutar `pnpm check`, mostrar resultados y estado real del workflow de GitHub.
7. **Continuidad:** explicar la integración prevista entre Reservas, Habitaciones y Pagos.

## Preguntas para practicar

**¿Por qué Clientes es un servicio?** Tiene una responsabilidad de negocio, contrato HTTP y propiedad de datos; otros dominios no necesitan conocer sus tablas ni su implementación.

**¿Cómo se integra ahora?** Todavía no hay otro servicio implementado. Se expone un contrato y claves públicas para la siguiente fase; no se debe presentar el diagrama como una integración ya ejecutada.

**¿Cómo evitan correos duplicados?** Normalización y restricción UNIQUE en PostgreSQL, con manejo de conflicto 409. Una prueba de concurrencia verifica que solo una solicitud tiene éxito.

**¿Cómo protegen un perfil?** Verificando firma, emisor, audiencia y vencimiento del JWT; luego se compara el `sub` con el UUID solicitado.

**¿Qué pasa si cae la base?** Readiness responde 503 y las operaciones fallan con error controlado sin revelar datos de conexión. No se presenta como sistema de alta disponibilidad.

**¿Ya evita reservas duplicadas?** No. Ese control pertenece a Habitaciones/Reservas y está pendiente, con bloqueo transaccional propuesto.

## Orden de trabajo siguiente

1. Acordar pago al reservar o al terminar la estadía y cerrar contratos internos.
2. Implementar Habitaciones con disponibilidad por fechas y bloqueo transaccional.
3. Implementar Reservas con estados e idempotencia, usando JWT de Clientes.
4. Implementar cuenta, pagos de prueba y avisos con reintentos.
5. Probar un flujo conjunto, incluida caída de dependencia y compensaciones.
6. Incorporar Restaurante y Spa/Actividades para completar el caso del resort.

La división de trabajo debe acordarse en el equipo. Todos deben poder explicar la arquitectura completa durante la defensa individual.
