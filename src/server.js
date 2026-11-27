const config = require('./config');
const app = require('./app');
const db = require('./db');
const { log } = require('./logger');

async function main() {
  if (config.mode === 'aws' && (!config.aws.bucket || !config.aws.queueUrl)) {
    throw new Error('MODE=aws requires S3_BUCKET and SQS_QUEUE_URL in .env');
  }
  await db.query('SELECT 1'); // fail fast if the database is unreachable

  if (config.mode === 'local') {
    // The local queue lives in memory. After a restart, put back anything still "queued"
    // so accepted submissions are never lost (on AWS, SQS keeps them for us).
    const queue = require('./adapters/queue');
    const { rows } = await db.query(`SELECT id FROM submissions WHERE status = 'queued' ORDER BY id`);
    for (const r of rows) await queue.send({ submissionId: r.id });
    if (rows.length) log('LOCAL_QUEUE_RESTORED', { count: rows.length });
    require('../worker/localWorker').start();
  }

  app.listen(config.port, () => log('API_STARTED', { port: config.port, mode: config.mode }));
}

main().catch((e) => {
  log('STARTUP_FAILED', { error: e.message });
  process.exit(1);
});
