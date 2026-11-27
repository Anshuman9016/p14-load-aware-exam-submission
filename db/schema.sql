-- P14 Load-Aware Examination Submission System - database schema (SRS Section 6)
-- All times are stored in UTC (TIMESTAMPTZ).

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(10)  NOT NULL CHECK (role IN ('student', 'teacher')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exams (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  teacher_id  INT NOT NULL REFERENCES users(id),
  start_time  TIMESTAMPTZ NOT NULL,
  deadline    TIMESTAMPTZ NOT NULL,
  max_file_mb INT NOT NULL DEFAULT 10 CHECK (max_file_mb BETWEEN 1 AND 50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (deadline > start_time)
);

CREATE TABLE IF NOT EXISTS submissions (
  id            SERIAL PRIMARY KEY,
  exam_id       INT NOT NULL REFERENCES exams(id),
  student_id    INT NOT NULL REFERENCES users(id),
  file_key      VARCHAR(300) NOT NULL,
  original_name VARCHAR(255),
  size_bytes    INT,
  status        VARCHAR(20) NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processed', 'failed')),
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  -- FR-7: one submission per student per exam, enforced by the database
  CONSTRAINT one_submission_per_exam UNIQUE (student_id, exam_id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_exam   ON submissions (exam_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status);
