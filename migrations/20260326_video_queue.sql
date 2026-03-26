-- Migration: 20260326_video_queue
-- Creates the video_queue table for the producer/publisher split architecture.
-- Videos are produced and stored here; uploaded to YouTube on demand via publish-video.mjs.

create table if not exists video_queue (
  id                       uuid        primary key default gen_random_uuid(),
  task_id                  uuid        not null unique,
  title                    text        not null,
  video_type               text        not null check (video_type in ('short', 'long')),
  supabase_video_path      text        not null,
  supabase_thumbnail_path  text,
  youtube_seo              jsonb       not null,
  status                   text        not null default 'ready' check (status in ('ready', 'uploaded', 'failed')),
  youtube_video_id         text,
  created_at               timestamptz default now(),
  uploaded_at              timestamptz
);

comment on table video_queue is 'Videos ready to be uploaded to YouTube. Populated by Stage 8. Consumed by publish-video.mjs.';
comment on column video_queue.task_id is 'References video_pipeline_runs.task_id';
comment on column video_queue.video_type is 'short = YouTube Shorts (<60s), long = standard video';
comment on column video_queue.supabase_video_path is 'Storage path in videos bucket, e.g. {taskId}/final.mp4';
comment on column video_queue.youtube_seo is 'title, description, tags from script.youtube_seo';
comment on column video_queue.status is 'ready = awaiting upload, uploaded = on YouTube, failed = upload error';
comment on column video_queue.youtube_video_id is 'YouTube video ID after successful upload';
