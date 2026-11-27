// Submission queue: an in-process queue that behaves like SQS (MODE=local),
// or Amazon SQS itself (MODE=aws). Same interface for both.
const config = require('../config');

// ---------- Local queue (SQS-like semantics) ----------
// Messages are hidden while being worked on (visibility timeout) and come back if the
// worker fails. After maxReceiveCount tries they move to a dead-letter list.
function makeLocal() {
  let nextId = 1;
  const messages = []; // { id, body, receiveCount, visibleAt }
  const deadLetter = [];

  return {
    kind: 'local',
    async send(body) {
      const msg = { id: String(nextId++), body: JSON.stringify(body), receiveCount: 0, visibleAt: 0 };
      messages.push(msg);
      return msg.id;
    },
    // "Messages waiting" = visible messages, like SQS ApproximateNumberOfMessages
    async size() {
      const now = Date.now();
      return messages.filter((m) => m.visibleAt <= now).length;
    },
    async inFlight() {
      const now = Date.now();
      return messages.filter((m) => m.visibleAt > now).length;
    },
    async dlqSize() { return deadLetter.length; },
    // Used only by the local worker
    receive(max = 10) {
      const now = Date.now();
      const out = [];
      for (const m of messages) {
        if (out.length >= max) break;
        if (m.visibleAt <= now) {
          m.receiveCount += 1;
          m.visibleAt = now + config.visibilityTimeoutSec * 1000;
          out.push(m);
        }
      }
      return out;
    },
    remove(id) {
      const i = messages.findIndex((m) => m.id === id);
      if (i >= 0) messages.splice(i, 1);
    },
    moveToDeadLetter(id) {
      const i = messages.findIndex((m) => m.id === id);
      if (i >= 0) deadLetter.push(...messages.splice(i, 1));
    },
  };
}

// ---------- Amazon SQS ----------
function makeSqs() {
  const { SQSClient, SendMessageCommand, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
  const sqs = new SQSClient({ region: config.aws.region });
  const QueueUrl = config.aws.queueUrl;

  async function attrs() {
    const r = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    return r.Attributes || {};
  }

  return {
    kind: 'sqs',
    async send(body) {
      const r = await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(body) }));
      return r.MessageId;
    },
    async size() { return Number((await attrs()).ApproximateNumberOfMessages || 0); },
    async inFlight() { return Number((await attrs()).ApproximateNumberOfMessagesNotVisible || 0); },
    async dlqSize() { return null; }, // watched by the CloudWatch alarm instead
  };
}

const queue = config.mode === 'aws' ? makeSqs() : makeLocal();

// Cached queue size so the busy check doesn't call SQS on every request
let cached = { value: 0, at: 0 };
queue.cachedSize = async function cachedSize() {
  if (Date.now() - cached.at < config.queueSizeCacheMs) return cached.value;
  cached = { value: await queue.size(), at: Date.now() };
  return cached.value;
};

module.exports = queue;
