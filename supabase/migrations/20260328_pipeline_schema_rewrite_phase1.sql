-- ============================================================
-- Pipeline Schema Rewrite — Phase 1 (Additive)
-- Run BEFORE rewriting any stage code. Safe to run while old code is running.
-- See docs/pipeline-schema-rewrite.md for full context.
-- ============================================================

-- Prerequisite: update_updated_at_column() must exist from migrations/001_create_tables.sql

-- 1. concepts table
CREATE TABLE IF NOT EXISTS concepts (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT          NOT NULL,
  theme         TEXT,
  synopsis      TEXT,
  characters    TEXT[]        NOT NULL DEFAULT '{}',
  outline       TEXT,
  art_style     TEXT          NOT NULL DEFAULT '3D Pixar animation still',
  video_type    TEXT          NOT NULL DEFAULT 'short' CHECK (video_type IN ('short', 'long')),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 2. youtube_seo table
CREATE TABLE IF NOT EXISTS youtube_seo (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT          NOT NULL,
  description   TEXT,
  tags          TEXT[]        DEFAULT '{}',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 3. video_output table
CREATE TABLE IF NOT EXISTS video_output (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  local_video_path        TEXT,
  video_url               TEXT,
  final_duration_seconds  NUMERIC,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 4. pipeline_state table (FK hub — one row per video)
CREATE TABLE IF NOT EXISTS pipeline_state (
  task_id           UUID          PRIMARY KEY,
  concept_id        UUID          REFERENCES concepts(id),
  youtube_seo_id    UUID          REFERENCES youtube_seo(id),
  video_output_id   UUID          REFERENCES video_output(id),
  episode_number    INTEGER,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS pipeline_state_updated_at ON pipeline_state;
CREATE TRIGGER pipeline_state_updated_at
  BEFORE UPDATE ON pipeline_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. scenes table (will replace scene_assets after Phase 2)
CREATE TABLE IF NOT EXISTS scenes (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID          NOT NULL,
  scene_number          INTEGER       NOT NULL,
  -- Script content (Stage 2)
  speaker               TEXT,
  emotion               TEXT,
  text                  TEXT,
  visual_description    TEXT,
  characters            TEXT[]        DEFAULT '{}',
  script_approved       BOOLEAN       NOT NULL DEFAULT false,
  -- Image assets (Stage 4)
  image_url             TEXT,
  prompt_used           TEXT,
  image_status          TEXT          NOT NULL DEFAULT 'pending' CHECK (image_status IN ('pending', 'completed', 'failed')),
  image_approved        BOOLEAN       NOT NULL DEFAULT false,
  -- Animation assets (Stage 5)
  animation_url         TEXT,
  animation_status      TEXT          NOT NULL DEFAULT 'pending' CHECK (animation_status IN ('pending', 'completed', 'failed')),
  animation_approved    BOOLEAN       NOT NULL DEFAULT false,
  -- Audio/TTS assets (Stage 6)
  audio_url             TEXT,
  enhanced_text         TEXT,
  audio_status          TEXT          NOT NULL DEFAULT 'pending' CHECK (audio_status IN ('pending', 'completed', 'failed')),
  audio_approved        BOOLEAN       NOT NULL DEFAULT false,
  -- Assembly metadata (Stage 7)
  environment           TEXT,
  -- Timestamps
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, scene_number)
);

CREATE INDEX IF NOT EXISTS idx_scenes_task_id ON scenes (task_id);

-- 6. episode_characters table
CREATE TABLE IF NOT EXISTS episode_characters (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID          NOT NULL,
  character_name        TEXT          NOT NULL,
  voice_id              TEXT,
  image_prompt          TEXT,
  reference_image_url   TEXT,
  episode_image_url     TEXT,
  tweaks                TEXT,
  status                TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, character_name)
);

CREATE INDEX IF NOT EXISTS idx_episode_characters_task_id ON episode_characters (task_id);

-- 7. Add video_url column to video_queue if not exists
ALTER TABLE video_queue ADD COLUMN IF NOT EXISTS video_url TEXT;

-- 8. Ensure UNIQUE constraint on video_pipeline_runs(task_id, stage_id) for launcher upsert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_pipeline_runs_task_id_stage_id_key'
  ) THEN
    ALTER TABLE video_pipeline_runs ADD CONSTRAINT video_pipeline_runs_task_id_stage_id_key UNIQUE (task_id, stage_id);
  END IF;
END $$;
