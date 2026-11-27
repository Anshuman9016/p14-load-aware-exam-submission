// In-memory counters for the /api/stats endpoint (FR-12, SRS 7.3)
const startedAt = new Date();
const counters = {
  accepted: 0,
  duplicates: 0,
  rejected: { rateLimit: 0, busy: 0, examClosed: 0, invalid: 0, error: 0 },
  submitTimesMs: [], // last 1000 submit response times
};

function recordAccepted(ms) {
  counters.accepted += 1;
  recordTime(ms);
}
function recordDuplicate(ms) {
  counters.duplicates += 1;
  recordTime(ms);
}
function recordRejected(reason) {
  counters.rejected[reason] = (counters.rejected[reason] || 0) + 1;
}
function recordTime(ms) {
  counters.submitTimesMs.push(ms);
  if (counters.submitTimesMs.length > 1000) counters.submitTimesMs.shift();
}

function summary() {
  const t = [...counters.submitTimesMs].sort((a, b) => a - b);
  const avg = t.length ? t.reduce((s, x) => s + x, 0) / t.length : 0;
  const p95 = t.length ? t[Math.min(t.length - 1, Math.floor(t.length * 0.95))] : 0;
  const rejectedTotal = Object.values(counters.rejected).reduce((s, x) => s + x, 0);
  const attempts = counters.accepted + counters.duplicates + rejectedTotal;
  return {
    since: startedAt.toISOString(),
    accepted: counters.accepted,
    duplicates: counters.duplicates,
    rejected: { total: rejectedTotal, ...counters.rejected },
    rejectedPercent: attempts ? +((rejectedTotal / attempts) * 100).toFixed(1) : 0,
    avgResponseMs: +avg.toFixed(1),
    p95ResponseMs: p95,
  };
}

module.exports = { recordAccepted, recordDuplicate, recordRejected, summary };
