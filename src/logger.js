// Structured JSON logs (SRS 7.2). On EC2 these go to PM2 logs / CloudWatch;
// on Lambda, stdout goes to CloudWatch Logs automatically.
function log(event, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}

module.exports = { log };
