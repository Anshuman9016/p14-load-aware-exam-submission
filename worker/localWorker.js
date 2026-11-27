// Local stand-in for AWS Lambda (MODE=local only). Polls the in-process queue and runs
// the same processSubmission() code that Lambda runs, up to WORKER_CONCURRENCY at a time.
const config = require('../src/config');
const queue = require('../src/adapters/queue');
const { processSubmission } = require('./processSubmission');
const { log } = require('../src/logger');

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 10); // like Lambda max concurrency
const POLL_MS = 500;
// Small artificial delay so the "queued" -> "processed" change is visible in the demo
const DEMO_DELAY_MS = Number(process.env.WORKER_DEMO_DELAY_MS || 3000);

let running = 0;
let enabled = true;

async function tick() {
  if (!enabled) return;
  const free = CONCURRENCY - running;
  if (free <= 0) return;
  for (const msg of queue.receive(free)) {
    running += 1;
    (async () => {
      try {
        if (DEMO_DELAY_MS) await new Promise((r) => setTimeout(r, DEMO_DELAY_MS));
        await processSubmission(JSON.parse(msg.body), msg.receiveCount, config.maxReceiveCount);
        queue.remove(msg.id);
      } catch {
        if (msg.receiveCount >= config.maxReceiveCount) queue.moveToDeadLetter(msg.id);
        // otherwise it becomes visible again after the visibility timeout
      } finally {
        running -= 1;
      }
    })();
  }
}

function start() {
  setInterval(tick, POLL_MS);
  log('WORKER_STARTED', { mode: 'local', concurrency: CONCURRENCY });
}

// Lets the teacher pause/resume the worker to demo the failure test (SRS 8.1)
function setEnabled(v) {
  enabled = !!v;
  log(enabled ? 'WORKER_RESUMED' : 'WORKER_PAUSED', {});
}

module.exports = { start, setEnabled, isEnabled: () => enabled };
