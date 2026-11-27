const express = require('express');
const db = require('../db');
const config = require('../config');
const queue = require('../adapters/queue');
const stats = require('../stats');
const { log } = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('teacher'));

function loadLevel(waiting) {
  if (waiting > config.overloadThreshold) return 'overloaded';
  if (waiting >= config.busyThreshold) return 'busy';
  return 'normal';
}

// GET /api/stats  (FR-12) - queue size, accepted/rejected counts, response times
router.get('/', async (req, res, next) => {
  try {
    const [waiting, inFlight, dlq, dbCounts] = await Promise.all([
      queue.size(),
      queue.inFlight(),
      queue.dlqSize(),
      db.query(`SELECT status, COUNT(*)::int AS n FROM submissions GROUP BY status`),
    ]);
    const byStatus = { queued: 0, processed: 0, failed: 0 };
    for (const r of dbCounts.rows) byStatus[r.status] = r.n;

    const worker = config.mode === 'local' ? require('../../worker/localWorker') : null;
    res.json({
      mode: config.mode,
      queue: { waiting, inFlight, deadLetter: dlq, level: loadLevel(waiting) },
      thresholds: {
        busy: config.busyThreshold, overloaded: config.overloadThreshold, rateLimitPerMin: config.rateLimitPerMin,
      },
      api: stats.summary(),
      submissionsByStatus: byStatus,
      worker: worker ? { running: worker.isEnabled() } : { running: 'managed by AWS Lambda' },
    });
  } catch (e) { next(e); }
});

// POST /api/stats/worker {"running": false|true}
// Local mode only: pause/resume the worker to demo the failure test (SRS 8.1).
// On AWS the same test is done by disabling the Lambda's SQS trigger.
router.post('/worker', (req, res) => {
  if (config.mode !== 'local') {
    return res.status(400).json({ error: 'On AWS, disable/enable the Lambda SQS trigger instead' });
  }
  const worker = require('../../worker/localWorker');
  worker.setEnabled(req.body?.running !== false);
  log('WORKER_TOGGLED', { by: req.user.id, running: worker.isEnabled() });
  res.json({ running: worker.isEnabled() });
});

module.exports = router;
