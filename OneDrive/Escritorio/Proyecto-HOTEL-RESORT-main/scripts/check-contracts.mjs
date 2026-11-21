import SwaggerParser from '@apidevtools/swagger-parser';

for (const service of [
  'clientes',
  'habitaciones',
  'reservas',
  'pagos-notificaciones',
]) {
  await SwaggerParser.validate(`services/${service}/openapi.json`);
  console.log(`OpenAPI válido: ${service}`);
}
