export class ReservasDomain {
  constructor(reservasRepository) {
    this.reservasRepository = reservasRepository;
  }

  async obtenerReservas() {
    return await this.reservasRepository.findAll();
  }

  async crearReserva(data) {
    if (!data.cliente_id || !data.habitacion_id || !data.fecha_inicio || !data.fecha_fin) {
      throw new Error('Faltan campos obligatorios para registrar la reserva');
    }
    return await this.reservasRepository.create(data);
  }
}