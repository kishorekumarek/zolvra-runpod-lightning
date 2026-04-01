# YouTube AI Pipeline — @tinytamiltales

## Pipeline Overview

Automated Tamil kids animated story production pipeline. Takes a story file and produces a fully assembled YouTube video through 8 stages with Telegram approval gates.

**Stage order:** 1B (story intake) -> 2 (script) -> 3 (characters) -> 6 (voice/TTS) -> 4 (illustration) -> 5 (animation) -> 7 (assembly) -> 8 (queue)

## How to Run

### New video from a story file
```bash
node scripts/launch-pipeline-from-story.mjs <story-file> [short|long]
# Or from stdin:
cat story.txt | node scripts/launch-pipeline-from-story.mjs - [short|long]
```
- `short` (default): YouTube Shorts, 9:16, 9 scenes, ~90s
- `long`: Standard video, 16:9, 24 scenes, ~4min

### Resume a failed/crashed pipeline
```bash
# Auto-finds the most recent incomplete pipeline and resumes
node scripts/launch-pipeline-from-story.mjs --resume

# Resume a specific pipeline by task_id
node scripts/launch-pipeline-from-story.mjs --resume <task_id>
```
Completed stages are skipped automatically. Each stage picks up where it left off (e.g., if Stage 2 approved 5 of 9 scenes before crashing, it resumes from scene 6).

### Publish a completed video to YouTube
```bash
node scripts/publish-video.mjs <task_id>
```
Videos are produced as UNLISTED. Darl publishes manually.

## Database

All pipeline state is in Supabase (PostgreSQL). Each stage reads from and writes to typed DB tables — no in-memory state passing.

**Key tables:** `concepts`, `scenes`, `youtube_seo`, `episode_characters`, `video_output`, `pipeline_state` (FK hub), `video_pipeline_runs` (stage execution tracking)

**Full schema:** See `docs/pipeline-schema-rewrite.md`

## Key Files

- `scripts/launch-pipeline-from-story.mjs` — single pipeline launcher (new + resume)
- `scripts/publish-video.mjs` — YouTube upload (on-demand)
- `lib/pipeline-db.mjs` — shared DB read/write helpers
- `lib/video-config.mjs` — video format config (scene count, duration, aspect ratio)
- `lib/stage-ids.mjs` — stage ID constants and execution order

## Rules

- Never make videos public — upload as UNLISTED only. Darl publishes manually.
- Never delete YouTube content.
- Always include `#Shorts` in description for short-format videos.
- Use `publish-video.mjs` for YouTube upload, never upload from stage code directly.
- Pipeline runs on one machine — final videos stored locally in `output/{taskId}/final.mp4` (not in Supabase Storage due to 50MB limit).
