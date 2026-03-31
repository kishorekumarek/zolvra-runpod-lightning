-- Migration: add_series_columns
-- Adds series tracking columns to video_queue for parallel series (e.g. Jungle Jambu)
-- alongside the existing TTT (Tiny Tamil Tales) pipeline.

ALTER TABLE video_queue ADD COLUMN IF NOT EXISTS series TEXT DEFAULT NULL;
ALTER TABLE video_queue ADD COLUMN IF NOT EXISTS series_ep_number INTEGER DEFAULT NULL;

COMMENT ON COLUMN video_queue.series IS 'Series identifier, e.g. jungle_jambu. NULL for standalone TTT videos.';
COMMENT ON COLUMN video_queue.series_ep_number IS 'Episode number within the series.';
