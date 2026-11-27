const express = require('express');
const db = require('../db');
const storage = require('../adapters/storage');
const { log } = require('../logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

// Loads a submission and checks the caller may see it:
// a student only their own, a teacher only for exams they created (SRS 4.2)
async function loadAllowed(req, res) {
  const id = toId(req.params.id);
  if (!id) { res.status(404).json({ error: 'Submission not found' }); return null; }
  const { rows } = await db.query(
    `SELECT s.*, e.teacher_id, e.title AS exam_title, e.deadline
     FROM submissions s JOIN exams e ON e.id = s.exam_id WHERE s.id = $1`, [id]);
  const s = rows[0];
  if (!s) { res.status(404).json({ error: 'Submission not found' }); return null; }
  const allowed = req.user.role === 'student' ? s.student_id === req.user.id : s.teacher_id === req.user.id;
  if (!allowed) { res.status(403).json({ error: 'You are not allowed to see this submission' }); return null; }
  return s;
}

// GET /api/submissions/:id  (FR-10) - check status
router.get('/:id', async (req, res, next) => {
  try {
    const s = await loadAllowed(req, res);
    if (!s) return;
    res.json({
      submissionId: s.id,
      examId: s.exam_id,
      examTitle: s.exam_title,
      status: s.status,
      fileName: s.original_name,
      acceptedAt: s.accepted_at,
      processedAt: s.processed_at,
      attempts: s.attempts,
      onTime: new Date(s.accepted_at) <= s.deadline,
    });
  } catch (e) { next(e); }
});

// GET /api/submissions/:id/download  (FR-11) - teacher only, link expires after 5 minutes
router.get('/:id/download', async (req, res, next) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Only teachers can download answer files' });
    const s = await loadAllowed(req, res);
    if (!s) return;
    const url = await storage.downloadUrl(s.file_key, s.original_name);
    log('DOWNLOAD_LINK', { submissionId: s.id, teacherId: req.user.id });
    res.json({ url, expiresInSeconds: 300 });
  } catch (e) { next(e); }
});

module.exports = router;
