-- ============================================================
-- Teaser support — opt-in teaser generation for long videos.
--
-- Flow: Vercel form checkbox → story_submissions.teasers_enabled
--   → trigger-pipeline-from-submission.mjs passes to launcher
--   → Stage 1B writes to concepts.teasers_enabled
--   → Stage 2 (when enabled) produces teaser plans in `teasers` table + marks scenes.is_teaser
--   → Stages 4 + 5 dual-generate 9:16 assets for flagged scenes
--   → Stage 7b assembles per-teaser MP4s, inserts video_queue rows with parent_task_id
-- ============================================================

-- 1. Opt-in flag on concepts (Stage 1B writes from submission)
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS teasers_enabled BOOLEAN NOT NULL DEFAULT false;

-- Defensive: shorts cannot have teasers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'concepts_teasers_require_long'
  ) THEN
    ALTER TABLE concepts
      ADD CONSTRAINT concepts_teasers_require_long
      CHECK (video_type = 'long' OR teasers_enabled = false);
  END IF;
END $$;

-- 2. Per-scene teaser flag + 9:16 asset URLs on scenes
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS is_teaser BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS image_url_teaser TEXT,
  ADD COLUMN IF NOT EXISTS animation_url_teaser TEXT;

-- 3. Teasers plan table — one row per teaser (3 per long video when enabled)
CREATE TABLE IF NOT EXISTS teasers (
  id                         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                    UUID          NOT NULL, -- parent long-video task
  teaser_number              INTEGER       NOT NULL CHECK (teaser_number BETWEEN 1 AND 3),
  archetype                  TEXT          NOT NULL CHECK (archetype IN ('setup', 'emotional', 'reveal_aftermath')),
  scene_numbers              INTEGER[]     NOT NULL,
  title_text                 TEXT          NOT NULL,
  hook_text                  TEXT,         -- reserved for future on-screen overlay (not rendered today)
  teaser_last_scene_dialogue TEXT          NOT NULL, -- regenerated ~4s character line ending on hook
  narrator_outro_tamil       TEXT          NOT NULL, -- contextual ~5-6s narrator VO
  local_video_path           TEXT,         -- set by Stage 7b
  final_duration_seconds     NUMERIC,      -- set by Stage 7b
  status                     TEXT          NOT NULL DEFAULT 'pending'
                                           CHECK (status IN ('pending', 'assembled', 'failed')),
  created_at                 TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, teaser_number)
);

CREATE INDEX IF NOT EXISTS idx_teasers_task_id ON teasers (task_id);

-- 4. Parent link on video_queue — teasers reference the long video's task_id
ALTER TABLE video_queue
  ADD COLUMN IF NOT EXISTS parent_task_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_video_queue_parent_task_id ON video_queue (parent_task_id);
