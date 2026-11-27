const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const storage = require('../adapters/storage');
const queue = require('../adapters/queue');
const stats = require('../stats');
const { log } = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

function examView(e, now = new Date()) {
  const state = now < e.start_time ? 'upcoming' : now > e.deadline ? 'closed' : 'open';
  return {
    id: e.id, title: e.title, teacherId: e.teacher_id, teacherName: e.teacher_name,
    startTime: e.start_time, deadline: e.deadline, maxFileMb: e.max_file_mb, state,
  };
}

// POST /api/exams  (FR-2, FR-3) - teacher only
router.post('/', requireRole('teacher'), async (req, res, next) => {
  try {
    const { title, startTime, deadline, maxFileMb } = req.body || {};
    if (!title || !startTime || !deadline) {
      return res.status(400).json({ error: 'title, startTime and deadline are required' });
    }
    const start = new Date(startTime);
    const end = new Date(deadline);
    if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'startTime and deadline must be valid dates' });
    if (end <= start) return res.status(400).json({ error: 'deadline must be after startTime' });
    const mb = maxFileMb === undefined || maxFileMb === '' ? 10 : Number(maxFileMb);
    if (!Number.isInteger(mb) || mb < 1 || mb > 50) return res.status(400).json({ error: 'maxFileMb must be 1-50' });

    const { rows } = await db.query(
      `INSERT INTO exams (title, teacher_id, start_time, deadline, max_file_mb)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [String(title).slice(0, 200), req.user.id, start, end, mb]
    );
    log('EXAM_CREATED', { examId: rows[0].id, teacherId: req.user.id });
    res.status(201).json({ exam: examView({ ...rows[0], teacher_name: req.user.name }) });
  } catch (e) { next(e); }
});

// GET /api/exams - teachers see their own exams; students see all exams + their submission
router.get('/', async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'teacher') {
      ({ rows } = await db.query(
        `SELECT e.*, u.name AS teacher_name,
                (SELECT COUNT(*)::int FROM submissions s WHERE s.exam_id = e.id) AS submission_count
         FROM exams e JOIN users u ON u.id = e.teacher_id
         WHERE e.teacher_id = $1 ORDER BY e.deadline DESC`, [req.user.id]));
      return res.json({ exams: rows.map((e) => ({ ...examView(e), submissionCount: e.submission_count })) });
    }
    ({ rows } = await db.query(
      `SELECT e.*, u.name AS teacher_name, s.id AS sub_id, s.status AS sub_status, s.accepted_at AS sub_accepted_at
       FROM exams e JOIN users u ON u.id = e.teacher_id
       LEFT JOIN submissions s ON s.exam_id = e.id AND s.student_id = $1
       ORDER BY e.deadline DESC`, [req.user.id]));
    res.json({
      exams: rows.map((e) => ({
        ...examView(e),
        mySubmission: e.sub_id ? { id: e.sub_id, status: e.sub_status, acceptedAt: e.sub_accepted_at } : null,
      })),
    });
  } catch (e) { next(e); }
});

// GET /api/exams/:id  - any logged-in user
router.get('/:id', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Exam not found' });
    const { rows } = await db.query(
      `SELECT e.*, u.name AS teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id WHERE e.id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Exam not found' });
    res.json({ exam: examView(rows[0]) });
  } catch (e) { next(e); }
});

// ---------- Submit (the important one) ----------

// Rate limit: 5 submit requests per minute per student (SRS 3.3 / 4.3)
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => config.rateLimitPerMin,
  keyGenerator: (req) => `user-${req.user.id}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    stats.recordRejected('rateLimit');
    log('SUBMISSION_REJECTED', { reason: 'rate_limit', studentId: req.user.id, examId: req.params.id });
    res.status(429).json({ error: 'Too many requests - please slow down and try again in a minute' });
  },
});

function reject(res, status, reason, statReason, ctx, error, extra = {}) {
  stats.recordRejected(statReason);
  log('SUBMISSION_REJECTED', { reason, ...ctx });
  return res.status(status).json({ error, ...extra });
}

// POST /api/exams/:id/submit  (FR-4 to FR-7) - student only
router.post('/:id/submit', requireRole('student'), submitLimiter, async (req, res, next) => {
  const t0 = Date.now();
  const examId = toId(req.params.id);
  const ctx = { studentId: req.user.id, examId };
  try {
    if (!examId) return reject(res, 404, 'exam_not_found', 'invalid', ctx, 'Exam not found');

    const { rows: examRows } = await db.query('SELECT * FROM exams WHERE id = $1', [examId]);
    const exam = examRows[0];
    if (!exam) return reject(res, 404, 'exam_not_found', 'invalid', ctx, 'Exam not found');

    // FR-4: only between start time and deadline (server clock, UTC)
    const now = new Date();
    if (now < exam.start_time) return reject(res, 422, 'exam_not_started', 'examClosed', ctx, 'This exam has not started yet');
    if (now > exam.deadline) return reject(res, 422, 'exam_closed', 'examClosed', ctx, 'The deadline for this exam has passed');

    // FR-7: one submission per exam - a retry returns the existing one instead of a duplicate
    const existing = await findExisting(examId, req.user.id);
    if (existing) {
      stats.recordDuplicate(Date.now() - t0);
      return res.status(200).json({ message: 'Already submitted', ...existing });
    }

    // SRS 4.3: refuse new work when the queue is overloaded
    const waiting = await queue.cachedSize();
    if (waiting > config.overloadThreshold) {
      res.set('Retry-After', String(config.retryAfterSeconds));
      return reject(res, 503, 'busy', 'busy', { ...ctx, queueSize: waiting },
        `System busy, please retry in ${config.retryAfterSeconds} seconds`, { retryAfter: config.retryAfterSeconds });
    }

    // Read the file (size limit comes from the exam)
    const file = await readUpload(req, res, exam.max_file_mb);
    if (!file) return reject(res, 400, 'no_file', 'invalid', ctx, 'Please attach your answer file (form field "file")');

    // 1) save file to storage (S3)
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-100) || 'answer';
    const fileKey = `exams/${examId}/student-${req.user.id}/${Date.now()}-${safeName}`;
    await storage.put(fileKey, file.buffer, file.mimetype);

    // 2) save the row with status "queued"
    const { rows } = await db.query(
      `INSERT INTO submissions (exam_id, student_id, file_key, original_name, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')
       ON CONFLICT ON CONSTRAINT one_submission_per_exam DO NOTHING
       RETURNING id, status, accepted_at`,
      [examId, req.user.id, fileKey, file.originalname.slice(0, 255), file.size]
    );
    if (!rows[0]) {
      // Two requests raced; the other one won. Return that one (FR-7).
      await storage.remove(fileKey).catch(() => {});
      const other = await findExisting(examId, req.user.id);
      stats.recordDuplicate(Date.now() - t0);
      return res.status(200).json({ message: 'Already submitted', ...other });
    }
    const sub = rows[0];

    // 3) send to the queue. Only after this succeeds do we say "Received" (FR-5, FR-6)
    try {
      await queue.send({ submissionId: sub.id });
    } catch (err) {
      await db.query('DELETE FROM submissions WHERE id = $1', [sub.id]).catch(() => {});
      await storage.remove(fileKey).catch(() => {});
      return reject(res, 500, 'queue_error', 'error', { ...ctx, error: err.message },
        'Could not accept your submission right now - nothing was saved, please try again');
    }

    const ms = Date.now() - t0;
    stats.recordAccepted(ms);
    log('SUBMISSION_ACCEPTED', { ...ctx, submissionId: sub.id, ms, queueSize: waiting });
    res.status(202).json({
      message: 'Received',
      submissionId: sub.id,
      status: sub.status,
      acceptedAt: sub.accepted_at,
    });
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') {
      return reject(res, 400, 'file_too_large', 'invalid', ctx, 'File is larger than this exam allows');
    }
    stats.recordRejected('error');
    log('SUBMISSION_REJECTED', { reason: 'error', ...ctx, error: e.message });
    next(e);
  }
});

async function findExisting(examId, studentId) {
  const { rows } = await db.query(
    'SELECT id, status, accepted_at FROM submissions WHERE exam_id = $1 AND student_id = $2', [examId, studentId]);
  return rows[0] ? { submissionId: rows[0].id, status: rows[0].status, acceptedAt: rows[0].accepted_at } : null;
}

function readUpload(req, res, maxMb) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 1 } })
    .single('file');
  return new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve(req.file))));
}

// GET /api/exams/:id/submissions  (FR-11) - teacher, own exams only
router.get('/:id/submissions', requireRole('teacher'), async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Exam not found' });
    const { rows: ex } = await db.query('SELECT * FROM exams WHERE id = $1', [id]);
    if (!ex[0]) return res.status(404).json({ error: 'Exam not found' });
    if (ex[0].teacher_id !== req.user.id) return res.status(403).json({ error: 'You can only see submissions for your own exams' });

    const { rows } = await db.query(
      `SELECT s.id, s.status, s.accepted_at, s.processed_at, s.attempts, s.original_name, s.size_bytes,
              u.id AS student_id, u.name AS student_name, u.email AS student_email
       FROM submissions s JOIN users u ON u.id = s.student_id
       WHERE s.exam_id = $1 ORDER BY s.accepted_at`, [id]);
    res.json({
      exam: examView(ex[0]),
      submissions: rows.map((r) => ({
        id: r.id, status: r.status, acceptedAt: r.accepted_at, processedAt: r.processed_at,
        attempts: r.attempts, fileName: r.original_name, sizeBytes: r.size_bytes,
        onTime: new Date(r.accepted_at) <= ex[0].deadline, // SRS 4.4: based on accepted time
        student: { id: r.student_id, name: r.student_name, email: r.student_email },
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
