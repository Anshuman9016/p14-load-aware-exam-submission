const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const { log } = require('../logger');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/register  (FR-1)
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password and role are required' });
    }
    if (!['student', 'teacher'].includes(role)) {
      return res.status(400).json({ error: 'role must be "student" or "teacher"' });
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id, name, email, role`,
      [String(name).slice(0, 100), String(email).toLowerCase(), hash, role]
    );
    if (!rows[0]) return res.status(409).json({ error: 'An account with this email already exists' });
    log('REGISTER', { userId: rows[0].id, role });
    res.status(201).json({ user: rows[0] });
  } catch (e) { next(e); }
});

// POST /api/auth/login  (FR-1) - JWT valid for 1 hour
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
      log('LOGIN_FAILED', { email: String(email).toLowerCase() });
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });
    log('LOGIN', { userId: user.id, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { next(e); }
});

module.exports = router;
