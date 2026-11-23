import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config.js';

export const pool = new Pool({
  connectionString: config.databaseUrl,
});