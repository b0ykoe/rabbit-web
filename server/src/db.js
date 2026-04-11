import Knex from 'knex';
import { config } from './config.js';

const db = Knex({
  client: 'mysql2',
  connection: {
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.database,
    user:     config.db.user,
    password: config.db.password,
    charset:  'utf8mb4',
  },
  pool: { min: 2, max: 10 },
});

export default db;
