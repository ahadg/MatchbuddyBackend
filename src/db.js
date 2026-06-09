import pg from 'pg';

import { config } from './config.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
});

export const db = {
  query(text, params) {
    return pool.query(text, params);
  },
  connect() {
    return pool.connect();
  },
  end() {
    return pool.end();
  },
};
