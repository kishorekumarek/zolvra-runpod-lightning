-- ============================================================
-- YouTube AI Pipeline — Database Migration 001
-- Project: zolvra-ops (eu-west-1)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. character_library
-- ============================================================
CREATE TABLE IF NOT EXISTS character_library (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT          NOT NULL UNIQUE,
  description         TEXT          NOT NULL,
  reference_image_url TEXT,
  image_prompt        TEXT,
  voice_id            TEXT          NOT NULL,
  approved            BOOLEAN       NOT NULL DEFAULT FALSE,
  feedback            TEXT[]        NOT NULL DEFAULT '{}',
  version             INTEGER       NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_character_library_approved ON character_library (approved);

-- Auto-update updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS character_library_updated_at ON character_library;
CREATE TRIGGER character_library_updated_at
  BEFORE UPDATE ON character_library
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. video_pipeline_runs
-- ============================================================
CREATE TABLE IF NOT EXISTS video_pipeline_runs (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID          NOT NULL,
  stage         INTEGER       NOT NULL CHECK (stage BETWEEN 0 AND 9),
  status        TEXT          NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','running','completed','failed','awaiting_review','approved','rejected')),
  cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
  error         TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task_id ON video_pipeline_runs (task_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status  ON video_pipeline_runs (status);

-- Cost summary view
CREATE OR REPLACE VIEW video_cost_summary AS
SELECT
  task_id,
  SUM(cost_usd) AS total_cost_usd,
  MAX(stage)    AS current_stage,
  COUNT(*)      AS stage_count
FROM video_pipeline_runs
GROUP BY task_id;

-- ============================================================
-- 3. pipeline_feedback
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_feedback (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id      UUID          NOT NULL,
  stage         INTEGER       NOT NULL CHECK (stage BETWEEN 0 AND 9),
  character_id  UUID          REFERENCES character_library(id) ON DELETE SET NULL,
  scene_number  INTEGER,
  prompt_used   TEXT,
  asset_url     TEXT,
  decision      TEXT          NOT NULL CHECK (decision IN ('approved','denied')),
  comment       TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_video_id     ON pipeline_feedback (video_id);
CREATE INDEX IF NOT EXISTS idx_feedback_character_id ON pipeline_feedback (character_id);
CREATE INDEX IF NOT EXISTS idx_feedback_decision     ON pipeline_feedback (decision);

-- ============================================================
-- 4. pipeline_settings
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_settings (
  key   TEXT    PRIMARY KEY,
  value JSONB   NOT NULL
);

-- ============================================================
-- 5. scene_assets
-- ============================================================
CREATE TABLE IF NOT EXISTS scene_assets (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id        UUID          NOT NULL,
  scene_number    INTEGER       NOT NULL,
  image_url       TEXT,
  animation_url   TEXT,
  prompt_used     TEXT,
  variant_picked  INTEGER       NOT NULL DEFAULT 1 CHECK (variant_picked >= 1),
  status          TEXT          NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','completed','failed')),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (video_id, scene_number)
);

CREATE INDEX IF NOT EXISTS idx_scene_assets_video_id ON scene_assets (video_id);

-- ============================================================
-- 6. ops_tasks (NEXUS board)
-- ============================================================
CREATE TABLE IF NOT EXISTS ops_tasks (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT          NOT NULL,
  description   TEXT,
  task_type     TEXT,
  priority      TEXT          NOT NULL DEFAULT 'medium'
                              CHECK (priority IN ('low','medium','high','critical')),
  status        TEXT          NOT NULL DEFAULT 'review'
                              CHECK (status IN ('backlog','todo','in_progress','review','done','cancelled')),
  parent_id     UUID          REFERENCES ops_tasks(id) ON DELETE SET NULL,
  content_url   TEXT,
  stream        TEXT          NOT NULL DEFAULT 'youtube',
  auto_created  BOOLEAN       NOT NULL DEFAULT FALSE,
  comments      JSONB         NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_tasks_status    ON ops_tasks (status);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_stream    ON ops_tasks (stream);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_parent_id ON ops_tasks (parent_id);

DROP TRIGGER IF EXISTS ops_tasks_updated_at ON ops_tasks;
CREATE TRIGGER ops_tasks_updated_at
  BEFORE UPDATE ON ops_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Done
-- ============================================================
