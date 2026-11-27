const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
