# Reservas — pendiente de implementación

Este directorio contiene diseño y contrato preliminar, no un servidor funcional.

Responsabilidad: ciclo de vida de estadías y coordinación con Habitaciones y Pagos. Puerto previsto: 3003. Base propia: reservas.

Datos previstos: Reserva, SolicitudIdempotente y EventoOutbox. Estados propuestos: PENDIENTE, CONFIRMADA, CANCELADA y REQUIERE_REVISION. El huésped procede del `sub` validado del JWT; no se aceptará un `huespedId` arbitrario desde el cliente.

Contrato: [openapi.json](openapi.json). Crear y cancelar reservas requieren idempotencia persistente. El total se obtiene de Habitaciones, nunca del navegador. Solo el propietario podrá consultar/cancelar en la primera fase.

Criterios de aceptación: reintentos no duplican reservas; fechas solapadas se rechazan mediante Habitaciones; un fallo de dependencia conserva un estado recuperable; si ya se creó un cargo, cancelar usa el contrato de anulación de Pagos. No modificar directamente las tablas de otros servicios.

La política inicial propuesta cobra al terminar la estadía. Acordarla con el equipo antes de programar; si requieren anticipo, agregar autorización, captura y reverso al flujo.
