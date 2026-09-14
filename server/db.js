const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL nincs beállítva.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  family: 4,
  ssl: { rejectUnauthorized: false }
});

module.exports = {
  query(text, params) {
    return pool.query(text, params);
  },
  pool
};
