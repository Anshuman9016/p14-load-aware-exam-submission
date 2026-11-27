// Shared worker logic (FR-8, FR-9). Used by the AWS Lambda handler and by the local worker.
const db = require('../src/db');
const storage = require('../src/adapters/storage');
const { log } = require('../src/logger');

/**
 * Process one queued submission.
 * @param {{submissionId:number}} body   message body
 * @param {number} receiveCount           how many times this message has been delivered
 * @param {number} maxReceiveCount        after this many tries it goes to the dead-letter queue
 * Throws on failure so the queue makes the message visible again.
 */
async function processSubmission(body, receiveCount, maxReceiveCount) {
  const { submissionId } = body;
  const started = Date.now();

  const { rows } = await db.query('SELECT id, file_key, status FROM submissions WHERE id = $1', [submissionId]);
  const sub = rows[0];
  if (!sub) {
    log('WORKER_SKIPPED', { submissionId, reason: 'not found' });
    return; // nothing to do - the message is simply removed
  }
  if (sub.status === 'processed') {
    log('WORKER_SKIPPED', { submissionId, reason: 'already processed' }); // idempotent (SRS 8.2)
    return;
  }

  await db.query('UPDATE submissions SET attempts = attempts + 1 WHERE id = $1', [submissionId]);

  try {
    const exists = await storage.exists(sub.file_key);
    if (!exists) throw new Error(`file not found in storage: ${sub.file_key}`);

    await db.query(
      `UPDATE submissions SET status = 'processed', processed_at = NOW() WHERE id = $1 AND status <> 'processed'`,
      [submissionId]
    );
    log('WORKER_PROCESSED', { submissionId, ms: Date.now() - started, attempt: receiveCount });
  } catch (err) {
    log('WORKER_FAILED', { submissionId, attempt: receiveCount, error: err.message });
    if (receiveCount >= maxReceiveCount) {
      // Last try: the queue will move it to the dead-letter queue (FR-9)
      await db.query(`UPDATE submissions SET status = 'failed' WHERE id = $1`, [submissionId]);
      log('MOVED_TO_DLQ', { submissionId, attempts: receiveCount });
    }
    throw err;
  }
}

module.exports = { processSubmission };
