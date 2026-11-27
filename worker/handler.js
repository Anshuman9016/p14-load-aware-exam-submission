// AWS Lambda entry point. Triggered by the SQS queue (batch size up to 10).
// Uses partial batch responses so one bad message doesn't make the whole batch retry.
// Enable "Report batch item failures" on the SQS trigger.
const { processSubmission } = require('./processSubmission');

const MAX_RECEIVE_COUNT = Number(process.env.MAX_RECEIVE_COUNT || 5);

exports.handler = async (event) => {
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    const receiveCount = Number(record.attributes?.ApproximateReceiveCount || 1);
    try {
      await processSubmission(JSON.parse(record.body), receiveCount, MAX_RECEIVE_COUNT);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
