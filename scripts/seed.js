// Demo data: npm run seed
// Creates one teacher, three students and one exam that is open right now (closes in 7 days).
// All demo accounts use the password: demo123
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const USERS = [
  { name: 'Demo Teacher', email: 'teacher@demo.com', role: 'teacher' },
  { name: 'Student One', email: 'student1@demo.com', role: 'student' },
  { name: 'Student Two', email: 'student2@demo.com', role: 'student' },
  { name: 'Student Three', email: 'student3@demo.com', role: 'student' },
];

(async () => {
  const hash = await bcrypt.hash('demo123', 10);
  for (const u of USERS) {
    await db.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`, [u.name, u.email, hash, u.role]);
  }
  const { rows: [teacher] } = await db.query(`SELECT id FROM users WHERE email = 'teacher@demo.com'`);
  const { rows: existing } = await db.query(
    `SELECT id FROM exams WHERE teacher_id = $1 AND title = 'Cloud Computing - Mid Term'`, [teacher.id]);
  if (!existing.length) {
    await db.query(
      `INSERT INTO exams (title, teacher_id, start_time, deadline, max_file_mb)
       VALUES ('Cloud Computing - Mid Term', $1, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days', 10)`,
      [teacher.id]);
  }
  console.log('Demo data ready. Logins (password demo123):');
  USERS.forEach((u) => console.log(`  ${u.role.padEnd(8)} ${u.email}`));
  await db.pool.end();
})().catch((e) => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
