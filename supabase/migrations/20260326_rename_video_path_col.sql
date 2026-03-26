-- Migration: rename supabase_video_path → local_video_path
-- The column has always stored a local filesystem path, never a Supabase Storage path.
-- This rename makes the column name match its actual purpose.
ALTER TABLE video_queue RENAME COLUMN supabase_video_path TO local_video_path;
