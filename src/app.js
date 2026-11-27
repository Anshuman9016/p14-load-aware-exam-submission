const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { log } = require('./logger');

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Nginx / a load balancer
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.mode, time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/stats', require('./routes/stats'));

// Local mode only: short-lived download links (S3 presigned URLs are used on AWS)
if (config.mode === 'local') {
  const storage = require('./adapters/storage');
  app.get('/api/files/:token', (req, res) => {
    try {
      const { key, filename } = jwt.verify(req.params.token, config.jwtSecret);
      res.attachment(filename || 'answer');
      storage.readStream(key).on('error', () => res.status(404).end()).pipe(res);
    } catch {
      res.status(403).json({ error: 'Download link is invalid or has expired' });
    }
  });
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Simple web pages (SRS 5.1)
app.use(express.static(path.join(__dirname, '..', 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  log('ERROR', { path: req.path, error: err.message });
  res.status(500).json({ error: 'Something went wrong, please try again' });
});

module.exports = app;
