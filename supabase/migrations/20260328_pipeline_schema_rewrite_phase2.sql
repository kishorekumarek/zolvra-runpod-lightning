-- ============================================================
-- Pipeline Schema Rewrite — Phase 2 (Destructive)
-- Run ONLY after ALL stage rewrites are complete and tested.
-- This is IRREVERSIBLE — existing pipeline state data will be lost.
-- See docs/pipeline-schema-rewrite.md for full context.
-- ============================================================

-- WARNING: Ensure no pipelines are running before executing.
-- WARNING: All data in scene_assets and pipeline_state JSONB will be destroyed.

-- 1. Drop pipeline_state JSONB column from video_pipeline_runs
ALTER TABLE video_pipeline_runs DROP COLUMN IF EXISTS pipeline_state;

-- 2. Drop old scene_assets table (replaced by scenes table)
DROP TABLE IF EXISTS scene_assets;

-- 3. Drop dead supabase_thumbnail_path column from video_queue
ALTER TABLE video_queue DROP COLUMN IF EXISTS supabase_thumbnail_path;
