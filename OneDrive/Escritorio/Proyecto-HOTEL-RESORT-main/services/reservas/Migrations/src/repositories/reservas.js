export class ReservasRepository {
  constructor(db) {
    this.db = db;
  }

  async findAll() {
    const result = await this.db.query('SELECT * FROM reservas');
    return result.rows;
  }

  async create(data) {
    const { cliente_id, habitacion_id, fecha_inicio, fecha_fin, estado } = data;
    const query = `
      INSERT INTO reservas (cliente_id, habitacion_id, fecha_inicio, fecha_fin, estado)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const values = [cliente_id, habitacion_id, fecha_inicio, fecha_fin, estado || 'PENDIENTE'];
    const result = await this.db.query(query, values);
    return result.rows[0];
  }
}