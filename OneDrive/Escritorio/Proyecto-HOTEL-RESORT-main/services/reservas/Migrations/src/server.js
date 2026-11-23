import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './database.js';
import { ReservasRepository } from './repositories/reservas.js';
import { ReservasDomain } from './domain/reservas.js';

const reservasRepository = new ReservasRepository(pool);
const reservasDomain = new ReservasDomain(reservasRepository);

const app = createApp({ reservasDomain });

app.listen(config.port, () => {
  console.log(`Servicio de reservas corriendo en el puerto ${config.port}`);
});