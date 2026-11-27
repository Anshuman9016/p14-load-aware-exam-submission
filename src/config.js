// Central configuration. Thresholds live here so they can be changed live during the viva
// (SRS 9.4 step 6) by editing .env and running `pm2 restart p14-api`.
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  mode: (process.env.MODE || 'local').toLowerCase(), // 'local' | 'aws'
  port: num(process.env.PORT, 3000),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: '1h', // FR-1

  databaseUrl: process.env.DATABASE_URL || 'postgres://p14:p14pass@localhost:5432/p14',
  dbSsl: process.env.DB_SSL === 'true',

  // Load management (SRS 3.3 / 4.3)
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 5),
  busyThreshold: num(process.env.BUSY_THRESHOLD, 500),
  overloadThreshold: num(process.env.OVERLOAD_THRESHOLD, 2000),
  retryAfterSeconds: num(process.env.RETRY_AFTER_SECONDS, 15),
  queueSizeCacheMs: 2000, // avoid calling SQS on every request

  // Worker / queue behaviour (mirrors SQS settings in aws mode)
  visibilityTimeoutSec: 60,
  maxReceiveCount: num(process.env.MAX_RECEIVE_COUNT, 5),

  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    bucket: process.env.S3_BUCKET,
    queueUrl: process.env.SQS_QUEUE_URL,
  },

  downloadLinkSeconds: 300, // SRS 6.3: links expire after 5 minutes
  localStorageDir: process.env.LOCAL_STORAGE_DIR || require('path').join(__dirname, '..', 'local-storage'),
};

module.exports = config;
