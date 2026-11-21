export const config = {
  port: process.env.PORT || 3003,
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/hotel_reservas'
};