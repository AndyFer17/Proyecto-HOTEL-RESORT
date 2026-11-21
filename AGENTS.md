# Contexto del proyecto

Proyecto académico UTP Hotel Resort Bahía Azul, Arquitectura Orientada al Servicio. El alcance actual son cuatro servicios de negocio: Clientes, Habitaciones, Reservas y Pagos/Notificaciones. Restaurante, Spa/Actividades y portal completo son extensiones. Leer README y docs/decisiones.md antes de cambiar políticas.

## Invariantes

- Cada servicio posee su base y esquema. No consultar ni modificar tablas de otro dominio; usar contratos HTTP o eventos.
- El huésped se toma del sub del JWT RS256 validado, nunca de un huespedId arbitrario enviado por cliente. Verificar propiedad dentro de cada dominio.
- La clave privada solo reside en Clientes. No guardar tokens, contraseñas ni cuerpos sensibles en logs o Git. No subir .env ni .local.
- El dinero usa numeric(12,2) y cadenas decimales; cálculos en centavos BigInt, nunca coma flotante.
- Toda mutación que pueda reintentarse debe preservar idempotencia, incluso tras reinicio y pérdida de respuesta. No reportar éxito mientras falten efectos de la saga.
- Habitaciones protege solapamientos por restricción transaccional, no solo por consulta previa. El rango es [desde,hasta).
- Pago, modificación y cancelación de cuenta comparten locks. Una operación en curso conserva su guard durable hasta recuperarse.
- Política académica actual: cargo al reservar, cobro separado al finalizar. No hay anticipos ni reembolsos automáticos; una cuenta pagada rechaza cambios/cancelación.
- Pasarela y entrega son simuladores académicos explícitos; se rechaza arrancar Pagos en producción. No describirlos como cobros o mensajes reales.
- No editar migraciones publicadas/aplicadas. Agregar archivos versionados; el migrador comprueba SHA-256.

## Trabajo y validación

Usar ramas codex/ y PR para revisión. No fusionar sin una instrucción explícita del propietario. El usuario autorizó completar los cuatro servicios y publicarlos en GitHub, manteniendo coherencia con el informe.

Comandos: pnpm install --frozen-lockfile, pnpm check, pnpm audit --prod --audit-level=high. pnpm test usa PGlite si no hay TEST_*_DATABASE_URL. CI configura cuatro PostgreSQL reales y arranca Compose con smoke de extremo a extremo. Verificar el resultado de la ejecución, sin confundir pruebas definidas con pruebas aprobadas.

pnpm setup:dev conserva .env existente; --force regenera secretos y puede requerir reconciliar las contraseñas de volúmenes ya creados. No borrar volúmenes del usuario para resolverlo por cuenta propia.

Actualizar docs y los cuatro OpenAPI cuando cambien contratos. Dejar en la descripción del PR qué cambió, pruebas realizadas, estado de CI y límites académicos reales.
