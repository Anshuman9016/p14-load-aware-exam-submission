// One-command local demo: npm run demo
// Starts a built-in PostgreSQL (no separate install needed), creates the tables and demo
// accounts, then starts the API on http://localhost:3000. Press Ctrl+C to stop everything.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.demo-db');
const PORT = Number(process.env.DEMO_DB_PORT || 5433);
const DATABASE_URL = `postgres://p14:p14pass@localhost:${PORT}/p14`;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: true,
  onLog: () => {}, onError: () => {},
});

const step = (msg) => console.log(`\n>>> ${msg}`);

function run(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], {
      cwd: root, stdio: 'inherit', env: { ...process.env, DATABASE_URL, DB_SSL: 'false', MODE: 'local' },
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
  });
}

let api;
async function shutdown() {
  step('Stopping...');
  if (api) api.kill();
  try { await pg.stop(); } catch { /* already stopped */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    step('First run: setting up the built-in database (takes a few seconds)');
    await pg.initialise();
  }
  step(`Starting the built-in PostgreSQL on port ${PORT}`);
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();
  const { rowCount: hasUser } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'p14'`);
  if (!hasUser) await client.query(`CREATE USER p14 WITH PASSWORD 'p14pass'`);
  const { rowCount: hasDb } = await client.query(`SELECT 1 FROM pg_database WHERE datname = 'p14'`);
  if (!hasDb) await client.query(`CREATE DATABASE p14 OWNER p14`);
  await client.end();

  step('Creating tables');
  await run('scripts/migrate.js');
  step('Adding demo accounts and an open exam');
  await run('scripts/seed.js');

  step('Starting the API');
  api = spawn(process.execPath, ['src/server.js'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DATABASE_URL, DB_SSL: 'false', MODE: 'local' },
  });
  api.on('exit', (code) => { if (code) console.error(`API stopped (code ${code})`); });

  setTimeout(() => {
    console.log('\n==========================================================');
    console.log('  Open  http://localhost:3000  in your browser');
    console.log('  Teacher : teacher@demo.com   / demo123');
    console.log('  Students: student1@demo.com  / demo123  (also student2, student3)');
    console.log('  Press Ctrl+C in this window to stop.');
    console.log('==========================================================\n');
  }, 1500);
} catch (e) {
  console.error('\nDemo failed to start:', e.message);
  try { await pg.stop(); } catch { /* ignore */ }
  process.exit(1);
}
