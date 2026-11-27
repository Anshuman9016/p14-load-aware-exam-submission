// Creates the tables: npm run migrate
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('Database schema is ready.');
  await db.pool.end();
})().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
