import express from 'express';

export function createApp({ reservasDomain }) {
  const app = express();
  app.use(express.json());

  app.get('/reservas', async (req, res, next) => {
    try {
      const reservas = await reservasDomain.obtenerReservas();
      res.json(reservas);
    } catch (err) {
      next(err);
    }
  });

  app.post('/reservas', async (req, res, next) => {
    try {
      const nuevaReserva = await reservasDomain.crearReserva(req.body);
      res.status(201).json(nuevaReserva);
    } catch (err) {
      next(err);
    }
  });

  return app;
}