# Pagos y Notificaciones — pendiente de implementación

Este directorio contiene diseño y contrato preliminar, no un servidor funcional.

Responsabilidad: cuenta consolidada, cargos, pagos y avisos. Se agrupan por alcance académico; separar internamente los módulos Cuenta, Pagos y Notificaciones. Puerto previsto: 3004. Base propia: pagos.

Datos previstos: Cargo, Pago, Notificacion y SolicitudIdempotente. Importes como `numeric(12,2)` en PostgreSQL y cadenas decimales en JSON. No usar coma flotante para cálculos financieros.

Contrato: [openapi.json](openapi.json). Cargos y avisos son operaciones internas con identidad de servicio. Consultar la cuenta o pagar requiere JWT y verificar que la reserva sea del huésped. Esta verificación se realizará por API de Reservas con contrato acordado, nunca consultando su base.

Criterios de aceptación: unicidad `(origen, origenId)`; el mismo pago no se cobra dos veces; anular conserva historial; monto validado contra saldo calculado; pasarela de prueba sin tarjetas reales; reintentos de avisos no alteran la reserva. Un correo fallido no revierte un pago aprobado.

Antes de integrar una pasarela real, definir su sandbox, conciliación y autenticidad de callbacks. El contrato inicial no demuestra esas funciones.
