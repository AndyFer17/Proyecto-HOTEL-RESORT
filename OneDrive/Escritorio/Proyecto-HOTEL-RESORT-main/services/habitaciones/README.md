# Habitaciones — pendiente de implementación

Este directorio contiene diseño y contrato preliminar, no un servidor funcional.

Responsabilidad: catálogo, tarifas, estado operativo, disponibilidad por fechas y control transaccional de inventario. Puerto previsto: 3002. Base propia: habitaciones.

Datos previstos: Habitacion, BloqueoTemporal y Ocupacion. Un estado operativo como LIMPIEZA no sustituye la disponibilidad por rango de fechas.

Contrato: [openapi.json](openapi.json). Endpoints internos de bloqueo, confirmación y liberación requieren identidad de Reservas, no el JWT de cualquier huésped. El monto cotizado se calcula aquí; nunca se confía en un precio enviado por el usuario.

Criterios de aceptación: dos solicitudes concurrentes sobre una habitación y fechas solapadas no se confirman; el bloqueo caduca; liberar es idempotente; se rechazan fechas inválidas y capacidad insuficiente. Usar transacción y exclusión de rangos o bloqueo equivalente probado. No leer la base de Reservas.
