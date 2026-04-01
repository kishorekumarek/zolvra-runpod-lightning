-- Migration 004: add series tracking columns
-- Adds series fields to video_queue and concepts tables for parallel series (e.g. Jungle Jambu).
-- NULL = TTT default; all existing rows unaffected.
-- Idempotent: safe to run multiple times.

-- video_queue: series tracking
ALTER TABLE video_queue
  ADD COLUMN IF NOT EXISTS series TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS series_ep_number INTEGER DEFAULT NULL;

COMMENT ON COLUMN video_queue.series IS 'Series identifier, e.g. jungle_jambu. NULL for standalone TTT videos.';
COMMENT ON COLUMN video_queue.series_ep_number IS 'Episode number within the series. NULL for non-series content.';

-- concepts: series context (for JJ character spec side-channel)
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS series TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS series_context JSONB DEFAULT NULL;

COMMENT ON COLUMN concepts.series IS 'Series identifier, e.g. jungle_jambu. NULL for standalone TTT.';
COMMENT ON COLUMN concepts.series_context IS 'JSONB character/world spec injected by series launcher. Read by stage-02 when present.';
