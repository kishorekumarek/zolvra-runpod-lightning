# Pipeline Schema Rewrite — Full Specification

> **Status:** Implementation complete (2026-03-28). Phase 1 migration run. Phase 2 migration pending end-to-end test. All stages rewritten, launcher unified, legacy scripts archived.
> **Created:** 2026-03-28
> **Project:** YouTube AI Pipeline for @tinytamiltales — a Tamil children's animated YouTube channel (3D Pixar style, target age 3-7).
> **Codebase location:** `workspace/streams/youtube/`
> **Database:** Supabase (PostgreSQL) on free tier. Storage: Supabase Storage (50MB per file limit on free tier).

---

## Table of Contents

1. [Background — What This Pipeline Does](#background)
2. [Why This Rewrite](#why-this-rewrite)
3. [Design Principles](#design-principles)
4. [Current Architecture and Its Problems](#current-architecture-and-its-problems)
5. [Design Decisions and Alternatives Considered](#design-decisions-and-alternatives-considered)
6. [Current Problems (Detailed)](#current-problems-detailed)
7. [New Database Schema](#new-database-schema)
8. [Stage-by-Stage Contracts](#stage-by-stage-contracts)
9. [Stage Function Signature Changes](#stage-function-signature-changes)
10. [Launcher Script Changes](#launcher-script-changes)
11. [Storage Changes](#storage-changes)
12. [Migration SQL](#migration-sql)
13. [Implementation Order](#implementation-order)
14. [Files That Need Changes](#files-that-need-changes)

---

## Background

The pipeline takes a story concept and produces a fully assembled YouTube video through 9 stages:

1. **Stage 0 (Research)** — generates story concepts via Claude, user picks one via Telegram buttons.
2. **Stage 1 (Concept Select)** — enriches the selected concept (scene-by-scene outline, character list, art style), Telegram approval. Stage 1B is an alternate entry point that takes a user-written story instead of generating one.
3. **Stage 2 (Script Gen)** — Claude generates N scenes (9 for shorts, 24 for longs) with Tamil dialogue, English visual descriptions, speakers, emotions. Per-scene Telegram approval.
4. **Stage 3 (Character Prep)** — resolves characters from `character_library`, creates missing ones via Claude, generates reference images, Telegram approval. Supports per-episode customization ("meenu wearing a rain coat").
5. **Stage 4 (Illustrate)** — generates one image per scene via Google Imagen, using character reference images for consistency. Telegram approval.
6. **Stage 5 (Animate)** — converts each scene image to a 10s video via Wan 2.6 image-to-video API. Falls back to freeze-frame if Wan fails. Telegram approval.
7. **Stage 6 (Voice/TTS)** — enhances dialogue with ElevenLabs v3 audio tags via Claude, generates TTS audio per scene. Telegram approval.
8. **Stage 7 (Assemble)** — downloads all assets, merges clip + audio + SFX per scene, concatenates, applies BGM + logo + end card via ffmpeg.
9. **Stage 8 (Queue)** — copies final video to persistent local output dir, inserts into `video_queue` for manual YouTube upload.
10. **Stage 9 (Publish)** — currently a no-op. YouTube upload is handled separately by `publish-video.mjs`.

There are two launcher scripts that orchestrate the pipeline:
- **`launch-pipeline-from-story.mjs`** — production launcher. Reads story from file, runs Stage 1B + stages 2-9. Has mid-pipeline restart support.
- **`run-1b-and-launch.mjs`** — alternate launcher. Runs stages in different order (TTS before illustration: 2→3→6→4→5→7→8). Skips Stage 9. No restart support.

Every stage has a Telegram approval loop where the user (Darl) reviews outputs via inline buttons. Some stages support "feedback mode" (per-scene approval) vs "auto mode" (no approval, auto-proceed).

### How state flows today

Each stage function has this signature:
```js
export async function runStageN(taskId, tracker, state = {}) {
  // reads from state object
  // does work
  // returns enriched state
  return { ...state, newOutputs };
}
```

The launcher passes the returned state to the next stage:
```js
pipelineState = await stageFn(taskId, tracker, pipelineState) || pipelineState;
```

This means the entire pipeline's accumulated state lives in one in-memory JavaScript object that grows with each stage.

---

## Why This Rewrite

During a line-by-line review of every stage, we discovered that the pipeline is **fragile and loses data on crash**. The root cause is that critical data exists only in the in-memory `state` object and is never persisted to the database.

### Specific problems discovered:

1. **Stage 2 produces `script`, `videoType`, `artStyle` that are never saved to DB.** Stage 3 reads `script.metadata.characters` from memory. If the pipeline crashes between Stage 2 and Stage 3, this data is lost. Stage 3 throws: `"Stage 3: script not found in pipeline state"`.

2. **Stage 3 produces `characterMap` with binary image Buffers that can't be serialized to JSONB.** The code has a comment acknowledging this: `"Large image buffers in characterMap cause serialization issues and data loss on pipeline restart."` A lightweight `characterVoiceMap` was added as a workaround, but it's also only in memory.

3. **Stage 6 audio files only exist in `/tmp`.** They're never uploaded to Supabase Storage. If `/tmp` is cleaned or the machine restarts, Stage 7 can't find the audio files and the pipeline fails.

4. **Stage 7 writes the final video to a tmpDir.** The local path is passed in memory to Stage 8. If the pipeline crashes, the path is lost.

5. **The `pipeline_state` JSONB column on `video_pipeline_runs` is abused.** Stages save `{ ...state, newStuff }` which dumps the ENTIRE accumulated pipeline state into one JSONB blob. This means:
   - Stage 5's `pipeline_state` contains a copy of Stage 2's scenes, Stage 3's characterMap, Stage 4's image paths — all duplicated.
   - Binary Buffer objects (from character reference images) cause JSON serialization failures.
   - Local `/tmp` paths stored in JSONB are meaningless after restart.
   - No schema — impossible to know what shape to expect per stage.

6. **Two launcher scripts have ~80% duplicated code** — the stage loop, error handling, DB upserts, budget tracking are copy-pasted. They also run stages in different orders (one does TTS before illustration, the other doesn't).

7. **`approveCharacterList()` is copy-pasted between Stage 1 and Stage 1B** — 70 identical lines.

8. **JSON fence-stripping (`text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()`)** is duplicated 6+ times across stages.

9. **No intermediate state saving in Stage 3** — if the pipeline crashes after approving 4 of 5 characters, all character work is lost and must be redone.

10. **`fetchTrendSummary()` in Stage 0 is hardcoded** — returns a static string instead of actual trend data. The "research" stage doesn't actually research anything.

---

## Design Principles

1. **Each stage reads only from DB/Storage** — no in-memory state object passed between stages.
2. **Each stage writes its outputs to DB/Storage** — nothing lives only in memory or `/tmp`.
3. **Binary data goes to Supabase Storage**, URLs/metadata go to DB tables.
4. **No JSONB blobs for pipeline state** — every piece of data has a typed column in a proper table.
5. **`tmpDir` is a local concern** — each stage creates its own temporary directory, not shared via state.
6. **`taskId` is the only argument passed** (plus `tracker` for cost tracking) — everything else is read from DB.
7. **Stages never write to `video_pipeline_runs`** — only launcher scripts do (status, timing, errors, cost).
8. **Stages never return state** — they either complete successfully (next stage starts) or throw (launcher marks failure).
9. **Stage 9 is dead** — YouTube upload is handled by separate `publish-video.mjs` script on demand.

---

## Current Architecture and Its Problems

### Current DB Schema (before rewrite)

The pipeline uses these Supabase tables:

**`character_library`** — permanent character roster shared across episodes.
```
id, name (UNIQUE), description, reference_image_url, image_prompt, voice_id, approved, feedback[], version, created_at, updated_at
```

**`video_pipeline_runs`** — one row per stage per video. Tracks execution + stores state in JSONB blob.
```
id, task_id, stage_id (text), status, cost_usd, error, pipeline_state (JSONB), started_at, completed_at
```
Note: `stage_id` was originally `stage` (integer), migrated to text via `20260327_add_stage_id_column.sql` and `20260327_drop_stage_integer_col.sql`. The `pipeline_state` JSONB column has no migration — it was added informally.

**`scene_assets`** — per-scene image and animation tracking.
```
id, video_id, scene_number, image_url, animation_url, prompt_used, variant_picked, status, created_at
UNIQUE (video_id, scene_number)
```
Note: No `audio_url` column. No scene content (text, speaker, emotion) — those live only in the JSONB blob.

**`ops_tasks`** — NEXUS board for human review cards.
```
id, title, description, task_type, priority, status, parent_id, content_url, stream, auto_created, comments (JSONB), created_at, updated_at
```

**`pipeline_feedback`** — logs every human approve/deny decision.
```
id, video_id, stage (integer — not migrated to text like video_pipeline_runs), character_id, scene_number, prompt_used, asset_url, decision, comment, created_at
```

**`pipeline_settings`** — key-value config store.
```
key (PK), value (JSONB)
```
Known keys: voice_feedback, feedback_collection_mode, feedback_collection_target, feedback_collection_completed, pipeline_abort.

**`video_queue`** — videos ready for YouTube upload.
```
id, task_id (UNIQUE), title, video_type, local_video_path, supabase_thumbnail_path, youtube_seo (JSONB), status, youtube_video_id, created_at, uploaded_at
```
Note: `local_video_path` was originally `supabase_video_path`, renamed via migration because it always stored local paths.

**Supabase Storage buckets:**
- `characters` — reference images (`{charId}/v{version}.png`, `{charId}/ep_{taskId}.png`)
- `scenes` — scene images + animations (`{taskId}/scene_01_image.png`, `{taskId}/scene_01_anim.mp4`)
- No audio bucket — Stage 6 audio only lives in `/tmp`

### What each stage currently reads from memory vs DB

| Stage | Reads from memory (state object) | Reads from DB |
|---|---|---|
| 2 | `state.concept` | character_library, pipeline_settings, video_pipeline_runs (episode count) |
| 3 | `state.script.metadata.characters`, `state.artStyle`, `state.scenes` | character_library |
| 4 | `state.scenes`, `state.characterMapWithImages`, `state.videoType`, `state.artStyle` | scene_assets (resume), character_library (reference images) |
| 5 | `state.scenes`, `state.sceneImagePaths`, `state.characterMap`, `state.tmpDir`, `state.videoType`, `state.artStyle` | nothing |
| 6 | `state.scenes`, `state.characterMap`, `state.characterVoiceMap`, `state.tmpDir` | character_library (voice_id fallback) |
| 7 | `state.scenes`, `state.sceneImagePaths`, `state.sceneAnimPaths`, `state.sceneAudioPaths`, `state.tmpDir`, `state.videoType` | nothing |
| 8 | `state.script`, `state.finalVideoPath`, `state.finalDurationSeconds`, `state.videoType` | nothing |

Stage 5 and Stage 7 read **nothing from DB** — they are 100% dependent on in-memory state. If the pipeline crashes before they run, they have no way to recover.

### What each stage saves to DB vs returns in memory

| Stage | Saves to `pipeline_state` JSONB | Returns in memory (not in DB) |
|---|---|---|
| 2 | scenes, episodeNumber, youtube_seo | `script`, `videoType`, `artStyle` |
| 3 | nothing (launcher saves `...state` blob) | `characterMap` (with Buffers), `characterVoiceMap`, `episodeOverrides` |
| 4 | `...state` + sceneImagePaths, approvedImages, tmpDir | same (all in the blob) |
| 5 | `...state` + sceneAnimPaths, approvedAnims | same |
| 6 | `...state` + enhancedSceneTexts, approvedSceneAudio, sceneAudioPaths | same |
| 7 | nothing (launcher saves) | `finalVideoPath`, `finalDurationSeconds` |
| 8 | nothing (updates status only) | `localVideoPath`, `queueStatus` |

### The `...state` spreading problem

When Stage 5 saves its pipeline_state, it does:
```js
pipeline_state: { ...state, sceneAnimPaths, approvedAnims }
```
This `...state` contains everything from stages 2, 3, and 4 — including `characterMap` with binary Buffers. This causes:
- Serialization failures (Buffers become `{type: "Buffer", data: [1,2,3,...]}` objects in JSON)
- Massive JSONB blobs (entire pipeline history duplicated in every stage's row)
- Stale data (a copy of scenes from stage 2 sits in stage 5's blob, never updated)

### The `script` object problem

Stage 2 constructs a `script` object:
```js
const script = {
  metadata: {
    characters: [...deduped character names from scenes + concept...],
  },
  youtube_seo,
};
```
This is a **derived object** — it's computed from `scenes` + `concept.characters`. But it's only returned in memory, not saved to DB. Stage 3 depends on `script.metadata.characters` and throws if it's missing. Stage 8 depends on `script.youtube_seo` for the video title.

In the new design, `script` is eliminated. Stage 3 derives character names directly from `concepts.characters`. Stage 8 reads youtube_seo from its own table.

---

## Design Decisions and Alternatives Considered

### Decision 1: Separate tables per data type vs single pipeline_state JSONB

**Chosen:** Separate tables (`concepts`, `scenes`, `youtube_seo`, `episode_characters`, `video_output`) with typed columns.

**Alternative considered:** A single `pipeline_state` table with one row per video, using JSONB columns for complex data (scenes array, concept object).

**Why we chose separate tables:**
- Typed columns make it clear what each stage reads/writes
- `scenes` table allows per-scene queries (resume by `WHERE image_status != 'completed'`) without parsing JSONB
- `episode_characters` table cleanly separates canonical characters (library) from per-episode assignments
- No JSONB blobs at all — everything is a typed column
- Individual scene approval booleans replace `{1: true, 2: true}` JSONB maps

### Decision 2: Merge scene content into scene_assets vs keep them separate

**Chosen:** Merge into a single `scenes` table that has both content (text, speaker) and asset tracking (image_url, audio_url, statuses).

**Why:** A scene is one entity. Splitting content and assets across two tables means every stage needs to join them. The scenes table has columns written by different stages (Stage 2 writes text, Stage 4 writes image_url, Stage 6 writes audio_url) but stages run sequentially so there's no write contention.

### Decision 3: `pipeline_state` table as FK hub vs each stage querying `video_pipeline_runs`

**Chosen:** A thin `pipeline_state` table with one row per video, holding FKs to `concepts`, `youtube_seo`, `video_output`. Each stage reads `pipeline_state` first to get FKs, then follows them.

**Why:** Cleaner than having each stage query multiple `video_pipeline_runs` rows to reconstruct state. The `pipeline_state` table shows at a glance how far a video has progressed (which FKs are non-NULL).

### Decision 4: Final video local storage vs Supabase Storage

**Chosen:** Local persistent storage (`output/{taskId}/final.mp4`). `video_output.video_url` column exists but stays NULL for now.

**Why:** Supabase free tier has a 50MB per file upload limit. Final videos are 80-300MB depending on format. The `video_url` column is future-proofing for when we move to S3/R2/etc. — no migration needed, just start populating it.

Scene assets (images ~2MB, animations ~10MB, audio ~1MB) stay on Supabase Storage — they're well under the limit.

### Decision 5: Upload audio to storage (new) vs keep in /tmp

**Chosen:** Upload to Supabase Storage. Stage 6 audio files are ~1MB each, well within limits.

**Why:** Today audio only lives in `/tmp`. If the pipeline crashes after Stage 6 and before Stage 7, or if `/tmp` is cleaned, audio is lost. Stage 7 can't assemble the video. Uploading to storage makes Stage 7 restartable.

### Decision 6: Stage 9 removed vs kept as optional

**Chosen:** Remove Stage 9 from the pipeline entirely.

**Why:** Stage 9 is already a no-op — it checks for `state.youtubeVideoId` which is never set during the pipeline. YouTube upload was already separated into `publish-video.mjs` and runs on-demand. Keeping Stage 9 adds confusion.

### Decision 7: `episode_characters` table vs passing characterMap in memory

**Chosen:** New `episode_characters` table with one row per character per video.

**Why:** `characterMap` contains binary Buffer objects (reference images) that can't be serialized to JSONB. The code already had a workaround (`characterVoiceMap` — a lightweight name→voiceId map). Rather than work around the serialization issue, we store the resolved character sheet in a proper table. Every downstream stage queries `episode_characters` instead of receiving an in-memory object.

Episode-specific customizations (tweaks, episode-specific images) are cleanly separated:
- `reference_image_url` = canonical look from character_library
- `episode_image_url` = customized look for this video (NULL if no customization)
- `tweaks` = human-readable description of customization
- Rule: if `episode_image_url` is not NULL, use it; else use `reference_image_url`

Rows are never deleted — they serve as a permanent record. On Stage 3 resume, existing approved rows are skipped.

### Decision 8: Per-asset status + approval columns vs single scene status

**Chosen:** Three separate status columns and three separate approval columns:
```
image_status / image_approved
animation_status / animation_approved
audio_status / audio_approved
```

**Why:** `status` tracks machine work (did generation succeed?), `approved` tracks human review (did user accept via Telegram?). A scene can be `image_status = 'completed'` but `image_approved = false` (generated successfully, user rejected it). Each stage owns its own columns independently.

**Alternative considered:** A single `status` column. Rejected because it would be ambiguous — "completed" could mean image done, animation done, or everything done.

### Decision 9: Launcher writes to video_pipeline_runs, stages write to data tables

**Chosen:** Clean separation — stages never touch `video_pipeline_runs`.

**Why:** `video_pipeline_runs` tracks execution metadata (when did it start, did it succeed, what was the error). That's the launcher's job. Stages focus on producing data. Today this is muddled — some stages write intermediate progress to `video_pipeline_runs.pipeline_state`. In the new model, intermediate progress goes to data tables (e.g., `scenes.script_approved = true` as each scene is approved), so stages have no reason to touch `video_pipeline_runs`.

### Decision 10: Stage execution order

**Current:** Two launchers run stages in different orders:
- `launch-pipeline-from-story.mjs`: 2→3→4→5→6→7→8→9
- `run-1b-and-launch.mjs`: 2→3→6→4→5→7→8

**Recommended new order:** 2→3→6→4→5→7→8 (TTS before illustration)

**Why:** TTS is cheaper and faster than image generation. Running it first catches dialogue issues before spending money on Imagen/Wan. Audio duration also drives video duration in assembly — knowing it earlier is useful. This order is already proven in `run-1b-and-launch.mjs`.

---

## Current Problems (Detailed)

> Note: These problems were identified during a line-by-line review of every stage file. The problems above in "Current Architecture" are restated here with more detail for completeness.

### Problem 1: Critical data lost on crash

These pieces of data exist only in the in-memory `state` object and are never saved to any database table:

| Data | Produced by | Consumed by | In DB today? | What breaks on crash |
|---|---|---|---|---|
| `script` (metadata.characters + youtube_seo) | Stage 2 | Stage 3, Stage 8 | No | Stage 3 throws `"script not found in pipeline state"` |
| `videoType` | Stage 2 | Stages 3-9 | No | Stages fall back to default, may produce wrong format |
| `artStyle` | Stage 2 | Stages 3,4,5 | No | Falls back to default (happens to be correct today, but fragile) |
| `characterMap` (with binary image buffers) | Stage 3 | Stages 4,5,6 | No — can't serialize (has Buffers) | Stage 4 throws `"characterMap not found"` |
| `characterVoiceMap` | Stage 3 | Stage 6 | No | Stage 6 falls back to character_library lookup (works but slower) |
| `episodeOverrides` | Stage 3 | (unused downstream) | No | No impact, but wasted data |
| `sceneAudioPaths` (local /tmp paths) | Stage 6 | Stage 7 | No | Stage 7 has no audio to assemble |
| `finalVideoPath` | Stage 7 | Stage 8 | No | Stage 8 throws `"finalVideoPath not found"` |

### Problem 2: `pipeline_state` JSONB blob is abused

Stages save `{ ...state, newStuff }` into `video_pipeline_runs.pipeline_state`. The `...state` spread operator copies the ENTIRE accumulated state from all previous stages. This means:
- Stage 5's JSONB blob contains copies of Stage 2's scenes, Stage 3's characterMap, Stage 4's image paths — all duplicated
- Binary Buffer objects (from character reference images in `characterMap`) fail JSON serialization. They become `{type: "Buffer", data: [1,2,3,...]}` objects that look truthy but break `buf.toString('base64')` calls
- Local `/tmp` paths stored in JSONB are meaningless after restart or `/tmp` cleanup
- No schema enforcement — each stage dumps whatever it wants, and consumers have to guess the shape
- The JSONB blob grows with each stage, wasting storage

### Problem 3: Audio files never uploaded to storage

Stage 6 writes audio MP3s to `/tmp/{taskId}/audio/` only. They are never uploaded to Supabase Storage. The `scene_assets` table has no `audio_url` column. If:
- The pipeline crashes between Stage 6 and Stage 7
- Or `/tmp` is cleaned up by the OS
- Or the machine restarts

...the audio is lost. Stage 7 cannot assemble the video.

### Problem 4: Final video path only in memory

Stage 7 writes the assembled video to a tmpDir path. This path is returned in the `state` object:
```js
return { ...state, finalVideoPath: finalPath, finalDurationSeconds: duration };
```
Stage 8 reads `state.finalVideoPath`. If the pipeline crashes between Stage 7 and Stage 8, the path is lost. Stage 8 does copy the file to a persistent `output/` directory, but only after reading the path from memory.

### Problem 5: Stage 3 has no intermediate state saving

Stage 3 processes characters one by one (Telegram approval per character, reference image generation). But it saves nothing to the database until it returns. If the pipeline crashes after approving 4 of 5 characters, all character work is lost. Compare this to Stage 2, which saves per-scene progress to `pipeline_state` after each Telegram approval.

### Problem 6: Code duplication

- `approveCharacterList()` — 70 identical lines copy-pasted between `stage-01-concept-select.mjs` and `stage-01b-story-intake.mjs`
- JSON fence-stripping — `text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()` appears 6+ times across stages
- Pipeline loop logic — stage execution, DB status updates, error handling, budget tracking duplicated between `launch-pipeline-from-story.mjs` and `run-1b-and-launch.mjs`

### Problem 7: Two launchers with different stage orders

- `launch-pipeline-from-story.mjs` runs: 2→3→4→5→6→7→8→9 (standard order)
- `run-1b-and-launch.mjs` runs: 2→3→6→4→5→7→8 (TTS before illustration)

The same story can produce different results depending on which launcher is used. The TTS-first order is actually better (cheaper, catches dialogue issues early) but it's not the default.

### Problem 8: Stage 4 is the only stage with a DB fallback

Stage 4 has this code to load scenes from DB if not in memory:
```js
if (!scenes) {
  const { data: stage2Row } = await sb2.from('video_pipeline_runs')
    .select('pipeline_state').eq('task_id', taskId).eq('stage_id', 'script')...
  scenes = ps?.scenes || ps?.script?.scenes;
}
```
No other stage does this. If any other stage doesn't have its input in memory, it just throws.

---

## New Database Schema

### `concepts` (NEW TABLE — one row per video)

Stores the enriched concept from Stage 1/1B. Replaces the concept object that was embedded in `pipeline_state` JSONB.

```sql
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
```

**`characters`** — array of character names planned for this story (e.g., `['narrator', 'meenu', 'kavi']`). Just names, not descriptions or voice IDs. Stage 3 uses this list to look up or create characters.

**`art_style`** — locked to "3D Pixar animation still" for now but stored per-concept so it can vary in future.

**`video_type`** — "short" (9 scenes, 90s, 9:16) or "long" (24 scenes, 240s, 16:9). Every downstream stage reads this to get video config.

**Who writes:** Stage 1 / Stage 1B (one INSERT after concept is approved)
**Who reads:** Stages 2, 3, 4, 5, 7, 8 (via FK from pipeline_state)

---

### `scenes` (REPLACES `scene_assets` — one row per scene per video)

Merges the current `scene_assets` table with scene content (text, speaker, emotion, visual_description) that was previously only in the `pipeline_state` JSONB blob. Adds audio tracking columns that didn't exist anywhere.

```sql
CREATE TABLE IF NOT EXISTS scenes (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID          NOT NULL,
  scene_number          INTEGER       NOT NULL,
  -- Script content (written by Stage 2)
  speaker               TEXT,
  emotion               TEXT,
  text                  TEXT,
  visual_description    TEXT,
  characters            TEXT[]        DEFAULT '{}',
  -- Script approval (Stage 2)
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
```

**Column explanations:**

- `speaker` — who speaks this line (e.g., "narrator", "meenu"). Must be a known character or narrator.
- `emotion` — one of: excited, happy, sad, scared, gentle, whisper, angry, normal.
- `text` — the Tamil script dialogue for this scene (Tamil Unicode).
- `visual_description` — English description used for image generation prompts.
- `characters` — array of ALL character names visible in this scene (not just the speaker). Used by Stage 4 to attach reference images.
- `enhanced_text` — Stage 6 version of `text` with ElevenLabs v3 audio tags (e.g., `<excited>`, pauses). Written by Stage 6.
- `image_url` — Supabase Storage path to the scene image PNG (e.g., `{task_id}/scene_01_image.png`).
- `animation_url` — Supabase Storage path to the scene animation MP4.
- `audio_url` — Supabase Storage path to the scene audio MP3. **NEW — audio is currently not uploaded to storage.**
- `prompt_used` — the full image generation prompt used by Stage 4 (for debugging/re-generation).
- `environment` — SFX environment tag assigned by Stage 7 (e.g., "forest_day", "village", "river"). Used for ambient sound selection.
- `*_status` columns — track whether the machine succeeded at generating the asset. `pending` = not attempted, `completed` = generated and uploaded, `failed` = generation failed.
- `*_approved` columns — track whether the human approved the asset via Telegram. A scene can be `image_status = 'completed'` but `image_approved = false` (generated successfully but rejected by user, awaiting regeneration).
- `script_approved` — whether the script text for this scene was approved during Stage 2's per-scene review.

**Resume queries per stage:**

| Stage | Query |
|---|---|
| Stage 2 (resume mid-review) | `WHERE task_id = ? AND script_approved = false` |
| Stage 4 (resume mid-illustration) | `WHERE task_id = ? AND image_status != 'completed'` |
| Stage 5 (resume mid-animation) | `WHERE task_id = ? AND animation_status != 'completed'` |
| Stage 6 (resume mid-TTS) | `WHERE task_id = ? AND audio_status != 'completed'` |

**Who writes:**

| Stage | Columns |
|---|---|
| Stage 2 | INSERT: task_id, scene_number, speaker, emotion, text, visual_description, characters. UPDATE: script_approved, text (on edit), visual_description (on regen), speaker (on regen), emotion (on regen) |
| Stage 4 | UPDATE: image_url, prompt_used, image_status, image_approved |
| Stage 5 | UPDATE: animation_url, animation_status, animation_approved |
| Stage 6 | UPDATE: audio_url, enhanced_text, audio_status, audio_approved |
| Stage 7 | UPDATE: environment |

**Who reads:**

| Stage | Columns |
|---|---|
| Stage 3 | visual_description, speaker (context for missing characters) |
| Stage 4 | scene_number, speaker, emotion, visual_description, characters (for prompt building) |
| Stage 5 | scene_number, speaker, emotion, visual_description, image_url (for Wan input) |
| Stage 6 | scene_number, speaker, emotion, text, visual_description (for TTS) |
| Stage 7 | animation_url, audio_url, image_url, visual_description, emotion (for assembly) |

---

### `youtube_seo` (NEW TABLE — one row per video)

Stores YouTube metadata generated by Stage 2. Previously embedded in `pipeline_state` JSONB.

```sql
CREATE TABLE IF NOT EXISTS youtube_seo (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT          NOT NULL,
  description   TEXT,
  tags          TEXT[]        DEFAULT '{}',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Who writes:** Stage 2 (one INSERT after script generation)
**Who reads:** Stage 8 (for video_queue row), publish-video.mjs (for YouTube upload metadata)

---

### `episode_characters` (NEW TABLE — one row per character per video)

Stores the resolved character sheet for a specific video. Replaces the in-memory `characterMap`, `characterVoiceMap`, and `episodeOverrides` objects.

```sql
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
```

**Column explanations:**

- `character_name` — lowercase name (e.g., "meenu").
- `voice_id` — ElevenLabs voice ID. Copied from `character_library` for existing characters, assigned from pool for new characters.
- `image_prompt` — the image generation prompt for this character in this episode. For unmodified characters, copied from `character_library.image_prompt`. For customized characters, includes the episode-specific tweak (e.g., "meenu... wearing a rain coat").
- `reference_image_url` — Supabase Storage path to the canonical reference image (from `character_library`).
- `episode_image_url` — Supabase Storage path to the episode-specific customized reference image. NULL if no customization. When not NULL, downstream stages use this instead of `reference_image_url`.
- `tweaks` — human-readable description of episode-specific customization (e.g., "wearing a rain coat"). NULL if no customization.
- `status` — `pending` (not yet reviewed), `approved` (use in this episode), `rejected` (dropped from this episode).

**Three scenarios:**

1. **Existing character, approved as-is:**
   - `voice_id`, `image_prompt`, `reference_image_url` copied from `character_library`
   - `episode_image_url = NULL`, `tweaks = NULL`, `status = 'approved'`

2. **Existing character, customized for this episode:**
   - `voice_id` copied from `character_library` (voice doesn't change)
   - `image_prompt` modified with tweak text
   - `reference_image_url` copied from `character_library` (kept as fallback)
   - `episode_image_url` = storage path to customized image
   - `tweaks` = "wearing a rain coat"
   - `status = 'approved'`

3. **New character (not in library):**
   - `voice_id` assigned from pool during Stage 3
   - `image_prompt` generated by Claude
   - `reference_image_url` = storage path to newly generated reference image
   - `episode_image_url = NULL` (the reference IS the episode image)
   - `tweaks = NULL`, `status = 'approved'`

**Downstream stages use this rule to pick reference image:**
```
if episode_image_url is NOT NULL → use episode_image_url
else → use reference_image_url
```

**Resume behavior:** On restart, Stage 3 queries `WHERE task_id = ? AND status = 'approved'` and skips already-approved characters. Characters with `status = 'pending'` or no row go through Telegram review again.

**Cleanup:** These rows are never deleted. They serve as a permanent record of which characters were used in each video with what settings.

**Who writes:** Stage 3 (INSERT per character after approval)
**Who reads:** Stage 4 (reference images for illustration), Stage 6 (voice_id for TTS). Note: Stage 5 does NOT read episode_characters — it uses scenes.visual_description and scenes.image_url as inputs to Wan.

---

### `video_output` (NEW TABLE — one row per video)

Stores the final assembled video metadata. Previously the local path was only in memory (`state.finalVideoPath`).

```sql
CREATE TABLE IF NOT EXISTS video_output (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  local_video_path        TEXT,
  video_url               TEXT,
  final_duration_seconds  NUMERIC,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Column explanations:**

- `local_video_path` — absolute filesystem path to the final video (e.g., `/path/to/output/{taskId}/final.mp4`). Written by Stage 7. This is a persistent directory (not `/tmp`).
- `video_url` — remote storage URL. NULL for now. Will be populated when pipeline moves to remote storage (S3, R2, etc.) in the future. Column exists to avoid future migration.
- `final_duration_seconds` — duration of the assembled video in seconds.

**Note on Supabase Storage:** Final videos exceed the 50MB free tier upload limit (a 90s short is ~80-150MB). That's why we store locally + record the path, rather than uploading to Supabase Storage. Scene assets (images ~2MB, animations ~10MB, audio ~1MB) are fine for Supabase Storage.

**Who writes:** Stage 7 (INSERT after assembly)
**Who reads:** Stage 8 (to verify file exists and get path for queue)

---

### `pipeline_state` (NEW TABLE — one row per video, FK references only)

Thin join table that connects a taskId to all its related data via foreign keys. Replaces the `pipeline_state` JSONB column on `video_pipeline_runs`.

```sql
CREATE TABLE IF NOT EXISTS pipeline_state (
  task_id           UUID          PRIMARY KEY,
  concept_id        UUID          REFERENCES concepts(id),
  youtube_seo_id    UUID          REFERENCES youtube_seo(id),
  video_output_id   UUID          REFERENCES video_output(id),
  episode_number    INTEGER,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Progressive filling — NULLs until that stage runs:**

| After stage | Fields populated |
|---|---|
| Stage 1 | `task_id`, `concept_id` |
| Stage 2 | `youtube_seo_id`, `episode_number` |
| Stage 7 | `video_output_id` |

**`episode_number`** — calculated by Stage 2 as COUNT of completed publish stages + 1. Stored here because it's derived at generation time and used by later stages.

**Scenes and episode_characters** don't need FKs here — they're looked up by `task_id` directly (many rows per video).

**Who writes:** Stage 1 (INSERT), Stage 2 (UPDATE youtube_seo_id + episode_number), Stage 7 (UPDATE video_output_id)
**Who reads:** Every stage (first query — get FKs, then follow them)

---

### `video_pipeline_runs` (EXISTING — modified)

Stage execution tracking. One row per stage per video. **Only written by launcher scripts, never by stages.**

```sql
-- Remove pipeline_state JSONB column
-- The stage_id and status columns already exist from previous migrations
-- No new columns needed

ALTER TABLE video_pipeline_runs DROP COLUMN IF EXISTS pipeline_state;
```

Remaining columns:
```
id              UUID PK
task_id         UUID
stage_id        TEXT          -- 'concept','script','characters','illustrate','animate','tts','assemble','queue'
status          TEXT          -- 'pending','running','completed','failed','aborted'
cost_usd        NUMERIC(10,6)
error           TEXT
started_at      TIMESTAMPTZ
completed_at    TIMESTAMPTZ

UNIQUE (task_id, stage_id)   -- REQUIRED for launcher .upsert() with onConflict. Added in Phase 1 migration if not already present.
```

**Note:** Stage 9 ('publish') is removed from the pipeline. YouTube upload is handled by `publish-video.mjs` separately.

**Who writes:** Launcher scripts only (before stage: status='running', after stage: status='completed' or 'failed'). Cost tracking: launcher calls `tracker.flush(stageNum)` which updates `cost_usd` on the row.
**Who reads:** Launcher scripts (resume logic — skip stages with status='completed')

---

### `video_queue` (EXISTING — modified)

Videos ready for YouTube upload. Populated by Stage 8. Consumed by `publish-video.mjs`.

```sql
-- Updated schema (reflects column rename from previous migration + new video_url column)
CREATE TABLE IF NOT EXISTS video_queue (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             UUID          NOT NULL UNIQUE,
  title               TEXT          NOT NULL,
  video_type          TEXT          NOT NULL CHECK (video_type IN ('short', 'long')),
  local_video_path    TEXT,
  video_url           TEXT,
  youtube_seo         JSONB         NOT NULL,
  status              TEXT          NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'uploaded', 'failed')),
  youtube_video_id    TEXT,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  uploaded_at         TIMESTAMPTZ
);
```

**Column explanations:**

- `local_video_path` — filesystem path to final video (from `video_output.local_video_path`).
- `video_url` — remote storage URL. NULL for now. Future-proofing for when final videos move to remote storage.
- `youtube_seo` — denormalized copy of youtube_seo data (JSONB). Copied from `youtube_seo` table so publish script doesn't need to join.
- `youtube_video_id` — YouTube's video ID after successful upload (e.g., "dQw4w9WgXcQ"). NULL until published. Used to build URL: `https://youtu.be/{youtube_video_id}`.
- `status` — `ready` (awaiting upload), `uploaded` (on YouTube), `failed` (upload error).

**Who writes:** Stage 8 (INSERT with status='ready'), publish-video.mjs (UPDATE status='uploaded', youtube_video_id, uploaded_at)
**Who reads:** publish-video.mjs

---

### Tables Unchanged

- **`character_library`** — permanent character roster. No schema changes. Stage 3 still inserts new characters here and reads existing ones.
- **`ops_tasks`** — NEXUS board. No changes. Stage 0 writes concept cards, Stage 1 updates them.
- **`pipeline_feedback`** — feedback logs. No changes. Used by publish-video.mjs and feedback-engine.mjs.
- **`pipeline_settings`** — key-value config. No changes. Read by various stages for settings (voice_feedback, feedback_collection_mode, etc.).

---

### Tables Removed

- **`scene_assets`** — replaced by `scenes` table which merges scene content + asset tracking.

---

## Stage-by-Stage Contracts

### Stage 0 (Research)

**Reads from DB:** Nothing.
**Internal work:** Generate story concepts via Claude, Telegram selection (pick/regenerate), Telegram review (approve/edit/back).
**Writes to DB:**

| When | Table | What |
|---|---|---|
| Each concept generated | `ops_tasks` | INSERT (task_type='story_concept', status='review') |
| Concept selected + approved | `ops_tasks` | UPDATE selected → status='done', others → status='cancelled' |

**Output:** Calls Stage 1 directly with `(conceptCardId, selectedConcept)` — this is a function call within the same process, not a DB handoff. Stage 0 does not create a pipeline_state row.

**Note on Stage 0 → Stage 1 handoff:** Stage 0 and Stage 1 run in the same process. Stage 0 passes the selected concept to Stage 1 as a function argument. This is the ONE place where in-memory handoff is kept — it's acceptable because:
- They run sequentially in the same process (no crash risk between them)
- Stage 0 doesn't have a taskId yet (that's generated by Stage 1 or the launcher)
- Alternatively, Stage 0 could write the raw concept to a temporary `ops_tasks` card and Stage 1 could read it from there — but this is already the current behavior (the concept card IS in ops_tasks), so no change needed.

For the **launcher entry points** (where Stage 1/1B is called directly without Stage 0):
- `launch-pipeline-from-story.mjs` reads a story file and passes it to `extractConceptFromStory()` (Stage 1B) as a string argument
- `run-1b-and-launch.mjs` does the same
- The launcher generates `taskId = randomUUID()` AFTER Stage 1B returns, then passes it to subsequent stages

**Who generates `taskId`:** The launcher script generates `taskId = randomUUID()` after Stage 1/1B completes. Stage 1/1B itself does not generate it. In the new model, the launcher generates taskId, then Stage 1/1B receives it and uses it to create the `pipeline_state` row. The signature for Stage 1/1B is a special case:

```js
// Stage 1/1B — special case: receives raw concept + taskId
export async function runStage1(taskId, tracker, rawConcept) {
  // enriches rawConcept via Claude + Telegram approval
  // writes to concepts + pipeline_state
}

// All other stages — standard signature
export async function runStageN(taskId, tracker) {
  // reads everything from DB
}
```

---

### Stage 1 / 1B (Concept Select / Story Intake)

**Reads from DB:** Nothing. Receives raw concept from Stage 0 (function arg) or user story text (Stage 1B arg). Also receives `taskId` from the launcher.
**Internal work:**
- Stage 1: Enriches concept via Claude (outline, characters, artStyle), Telegram approval (up to 4 rejections), character list approval (add/remove).
- Stage 1B: Extracts metadata from user story text via Claude, Telegram approval, character list approval. The user's original story text becomes the outline.

**Writes to DB:**

| When | Table | What |
|---|---|---|
| After enrichment approved + characters approved | `concepts` | INSERT (title, theme, synopsis, characters, outline, art_style, video_type) → returns `concept_id` |
| Immediately after | `pipeline_state` | INSERT (task_id, concept_id) |

**On error:** Throws. Nothing was written (writes only happen at the end on success).
**On success:** Launcher marks `video_pipeline_runs` stage_id='concept' as completed.

---

### Stage 2 (Script Gen)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `pipeline_state` | WHERE task_id = ? | `concept_id` |
| `concepts` | WHERE id = concept_id | title, theme, synopsis, characters, outline, art_style, video_type |
| `character_library` | WHERE approved = true | name, description, image_prompt (prompt context — so Claude knows existing characters and their appearance) |
| `video_queue` | WHERE status = 'uploaded' | COUNT → episode_number (counts successfully published videos. Previously counted `video_pipeline_runs` with stage_id='publish', but Stage 9 is removed. `video_queue` with status='uploaded' is the new source of truth for "how many videos have been published.") |
| `pipeline_settings` | WHERE key = 'voice_feedback' | value (voice feedback from past episodes) |
| `scenes` | WHERE task_id = ? AND script_approved = true | Resume: which scenes already approved |

**Reads from disk:** `tamil-style-guide.md`, `video-feedback.md` (local files in `lib/` directory).

**Internal work:**
1. Build system prompt from concept + character library + style guide + feedback + video config.
2. Call Claude Sonnet → generate N scenes as JSON (up to 3 retries). N = 9 for shorts, 24 for longs.
3. Validate: exact scene count, Tamil Unicode in text, word count (8-25 for shorts, 15-30 for longs), valid speakers (from character_library + concepts.characters + narrator), valid emotions.
4. Auto-fix: unknown speakers flagged as rogue → set to narrator, text rewritten to third-person narrator perspective via Claude. Invalid emotions → default to 'normal'. Missing characters array → fallback to [speaker].
5. Generate youtube_seo (or fallback if Claude omitted it).
6. Per-scene Telegram approval loop:
   - Approved → mark scene as approved.
   - Rejected with `text: ...` → direct text replacement, no Claude call.
   - Rejected with other feedback → Claude regenerates that single scene (with +-2 surrounding scenes as context).

**Writes to DB:**

| When | Table | What |
|---|---|---|
| After all scenes generated + validated | `scenes` | INSERT N rows (task_id, scene_number, speaker, emotion, text, visual_description, characters) |
| After all scenes generated + validated | `youtube_seo` | INSERT (title, description, tags) → returns `seo_id` |
| After all scenes generated + validated | `pipeline_state` | UPDATE set youtube_seo_id = seo_id, episode_number = N |
| Each scene approved via Telegram | `scenes` | UPDATE set script_approved = true WHERE task_id AND scene_number |
| Each scene rejected + regenerated | `scenes` | UPDATE set text, visual_description, speaker, emotion WHERE task_id AND scene_number |

**On error:** Throws. Partial state is safe — scenes in DB with script_approved flags show progress. Restart picks up from first unapproved scene.
**On success:** Launcher marks `video_pipeline_runs` stage_id='script' as completed.

---

### Stage 3 (Character Prep)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `pipeline_state` | WHERE task_id = ? | `concept_id` |
| `concepts` | WHERE id = concept_id | characters (name list), art_style |
| `scenes` | WHERE task_id = ? | visual_description, speaker (context for missing character generation) |
| `character_library` | WHERE name ILIKE ? AND approved = true | Full row per character (exists or missing?) |
| `episode_characters` | WHERE task_id = ? AND status = 'approved' | Resume: which characters already processed |

**Reads from storage:** Cached character reference images (`{charId}/v{version}.png`).

**Internal work:**

**A. Lookup** — for each character name from `concepts.characters`, query `character_library`. Found → existing. Not found → missing.

**B. Existing characters** — Telegram review with 3 options:
- **Approve** → copy data from `character_library` to `episode_characters` as-is.
- **Customize** → user provides tweak text (e.g., "wearing a rain coat"). Generate episode-specific reference image (up to 3 attempts with Telegram approval, Claude refines prompt on rejection). Upload to storage.
- **Reject** → insert `episode_characters` row with `status = 'rejected'`. Character dropped from this episode.

**C. Missing characters** — Claude generates description + image_prompt from character name + visual context from scenes. Telegram approval loop (up to 4 cycles, diff-style display on retries showing what changed). On approval:
- Classify voice type via Claude (kid / elder_male / elder_female).
- Pick voice from pool via `pickVoiceFromPool()`, avoiding already-used voices.
- INSERT into `character_library` (permanent — this character now exists for all future episodes).
- INSERT into `episode_characters` for this episode.

**D. Reference images** — for characters without a reference image, generate via image gen (up to 3 attempts), Telegram approval, upload to storage, update `character_library.reference_image_url`.

**Writes to DB:**

| When | Table | What |
|---|---|---|
| New character approved | `character_library` | INSERT (name, description, image_prompt, voice_id, approved=true) |
| New character reference image approved | `character_library` | UPDATE reference_image_url |
| Each character finalized | `episode_characters` | INSERT (task_id, character_name, voice_id, image_prompt, reference_image_url, episode_image_url, tweaks, status) |

**Writes to storage:** Reference images (`characters/{charId}/v{version}.png`), episode-specific images (`characters/{charId}/ep_{taskId}.png`).

**On error:** Throws. Partial state is safe — new characters in `character_library` survive (permanent). `episode_characters` rows already inserted survive. On restart, skips characters with `status = 'approved'` in `episode_characters`.
**On success:** Launcher marks `video_pipeline_runs` stage_id='characters' as completed.

---

### Stage 4 (Illustrate)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `pipeline_state` | WHERE task_id = ? | `concept_id` |
| `concepts` | WHERE id = concept_id | art_style, video_type (→ aspect ratio) |
| `scenes` | WHERE task_id = ? AND image_status != 'completed' | Scenes needing images + their visual_description, characters array |
| `episode_characters` | WHERE task_id = ? | image_prompt, reference_image_url, episode_image_url per character |

**Reads from storage:** Character reference images (downloaded from `episode_image_url` if not NULL, else `reference_image_url`).

**Internal work:**

For each scene where `image_status != 'completed'`:
1. Build image prompt from `scene.visual_description` + character appearance from `episode_characters`.
2. Download reference images for characters visible in this scene (`scene.characters` array) from storage. Up to 4 reference images (Gemini cap).
3. Call image gen via `generateSceneImage()` (up to 3 retries via `withRetry()`).
4. Upload image to Supabase Storage.
5. If feedback mode ON: send image to Telegram for approval.
   - Approved → set image_approved = true.
   - Rejected → append feedback to visual_description, regenerate, loop.
6. If feedback mode OFF: auto-approve (set both image_status='completed' and image_approved=true).
7. 7s delay between scenes (Imagen 10 req/min rate limit).

**Writes to DB:**

| When | Table | What |
|---|---|---|
| Image generated + uploaded | `scenes` | UPDATE image_url, prompt_used, image_status='completed' |
| Image approved via Telegram | `scenes` | UPDATE image_approved = true |
| Image gen failed | `scenes` | UPDATE image_status='failed' |

**Writes to storage:** Scene images (`scenes/{task_id}/scene_01_image.png`).

**On error:** Throws if failures exceed `MAX_SCENE_FAILURES` (5). For individual failures, sends Telegram alert for manual upload. Partial state safe — restart via `WHERE image_status != 'completed'`.
**On success:** Launcher marks `video_pipeline_runs` stage_id='illustrate' as completed.

---

### Stage 5 (Animate)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `pipeline_state` | WHERE task_id = ? | `concept_id` |
| `concepts` | WHERE id = concept_id | video_type (→ aspect ratio), art_style |
| `scenes` | WHERE task_id = ? AND animation_status != 'completed' | scene_number, speaker, emotion, visual_description, image_url |

**Reads from storage:** Scene images (signed URLs passed to Wan 2.6 API).

**Internal work:**

For each scene where `animation_status != 'completed'`:
1. Build Wan animation prompt (max 300 chars — setting, emotion, description, art style, orientation).
2. Get signed URL for scene image from Supabase Storage.
3. Submit to Wan 2.6 image-to-video API (up to 3 retries, 30s backoff).
4. Poll for result (up to 10 min timeout).
5. Download video, upload to Supabase Storage.
6. If feedback mode ON: send video to Telegram for approval.
   - Approved → set animation_approved = true.
   - Rejected → refine Wan prompt via Claude, regenerate, loop.
7. If feedback mode OFF: auto-approve.
8. If Wan fails entirely → static fallback (freeze-frame 10s video from still image via ffmpeg).
9. 10s delay between Wan jobs (rate limit).

**Writes to DB:**

| When | Table | What |
|---|---|---|
| Animation generated + uploaded | `scenes` | UPDATE animation_url, animation_status='completed' |
| Animation approved via Telegram | `scenes` | UPDATE animation_approved = true |
| Static fallback used | `scenes` | UPDATE animation_url (fallback video), animation_status='completed' |
| Animation failed entirely | `scenes` | UPDATE animation_status='failed' |

**Writes to storage:** Scene animations (`scenes/{task_id}/scene_01_anim.mp4`).

**On error:** Throws if failure ratio > 80% (NSFW_HALT_RATIO). Partial state safe — restart via `WHERE animation_status != 'completed'`.
**On success:** Launcher marks `video_pipeline_runs` stage_id='animate' as completed.

---

### Stage 6 (Voice/TTS)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `scenes` | WHERE task_id = ? AND audio_status != 'completed' | scene_number, speaker, emotion, text, visual_description |
| `episode_characters` | WHERE task_id = ? AND character_name = scene.speaker | voice_id |
| `character_library` | WHERE name ILIKE scene.speaker | voice_id (fallback if episode_characters has no voice_id) |

**Voice ID resolution order:**
1. `episode_characters.voice_id` for this task_id + speaker name
2. `character_library.voice_id` for speaker name (fallback)
3. `VOICE_MAP[speaker]` from voice-config.mjs (hardcoded fallback)
4. Default narrator voice (last resort)

Skip any voice_id that equals 'PLACEHOLDER' (legacy characters not yet assigned).

**Internal work:**

1. Batch enhance all unapproved scenes — send scene text + emotion to Claude Haiku, adds ElevenLabs v3 audio tags (`<excited>`, pauses, emphasis markers).
2. Per-scene loop:
   - Call ElevenLabs TTS with enhanced text + resolved voice_id (up to 3 retries, 10s backoff).
   - Upload audio MP3 to Supabase Storage. **NEW — currently audio only lives in /tmp.**
   - If feedback mode ON: send audio to Telegram for approval.
     - Approved → done.
     - Rejected with `text: ...` or `change dialogue to ...` → direct text replacement, re-enhance via Claude, re-generate TTS.
     - Rejected with other feedback → extract emotion hint from comment, re-enhance with modified emotion, re-generate TTS.
   - Record voice feedback via `recordVoiceFeedback()` for future episode improvement.
   - If feedback mode OFF: auto-approve.

**Writes to DB:**

| When | Table | What |
|---|---|---|
| Audio generated + uploaded | `scenes` | UPDATE audio_url, enhanced_text, audio_status='completed' |
| Audio approved via Telegram | `scenes` | UPDATE audio_approved = true |
| Audio rejected + re-enhanced | `scenes` | UPDATE enhanced_text (new version, audio_status stays or resets) |
| Audio failed | `scenes` | UPDATE audio_status='failed' |
| Voice feedback recorded | `pipeline_feedback` | INSERT feedback row |

**Writes to storage:** Scene audio (`scenes/{task_id}/scene_01_audio.mp3`). **NEW — must add audio upload to storage.**

**On error:** Throws. Partial state safe — restart via `WHERE audio_status != 'completed'`.
**On success:** Launcher marks `video_pipeline_runs` stage_id='tts' as completed.

---

### Stage 7 (Assemble)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `pipeline_state` | WHERE task_id = ? | `concept_id` |
| `concepts` | WHERE id = concept_id | video_type (→ video scale, aspect ratio for ffmpeg) |
| `scenes` | WHERE task_id = ? ORDER BY scene_number | animation_url, audio_url, image_url, visual_description, emotion |

**Reads from storage:** Animation MP4s, audio MP3s, scene images (fallback if no animation).
**Reads from disk:** BGM file (via `getBgmPath()`), SFX files (via `getSfxPath()`), channel logo (`assets/channel-logo.png`), end card (`assets/shorts_end_card.mp4` or `assets/end-card.mp4` + `assets/end_card_audio.mp3`). These are local assets bundled with the project, not pipeline data.

**Internal work:**
1. Classify scene environments via Claude Haiku → map each scene to one of 7 categories (forest_day, forest_rain, river, village, night, sky, crowd_children) for SFX selection.
2. Download all scene assets from Supabase Storage to local tmpDir.
3. Per scene:
   - If animation_url exists → download animation, merge with audio + SFX. Handle duration mismatches (loop video if audio longer, pad audio with silence if video longer).
   - Else if image_url exists → still image + audio (zoompan effect via ffmpeg).
   - Else → skip scene, log warning.
4. Concatenate all assembled scene clips (ffmpeg concat).
5. Apply BGM overlay (volume 0.1, fade in 2s, fade out 3s before end).
6. Apply channel logo overlay (top-right, 12% of video width, 40px padding).
7. Append end card (format-specific: `shorts_end_card.mp4` for shorts, `end-card.mp4` for longs). Re-encode to match main video dimensions, apply -shortest to fix sync drift.
8. Save final video to persistent `output/{taskId}/final.mp4`.

**Writes to DB:**

| When | Table | What |
|---|---|---|
| Environment classified per scene | `scenes` | UPDATE environment per scene |
| Final video saved to persistent dir | `video_output` | INSERT (local_video_path, final_duration_seconds, video_url=NULL) → returns video_output_id |
| After insert | `pipeline_state` | UPDATE video_output_id |

**On error:** Throws if no scenes were assembled. Stage 7 is mostly a single batch operation — not much incremental state to save. On restart, it starts over (downloads everything from storage again).
**On success:** Launcher marks `video_pipeline_runs` stage_id='assemble' as completed.

---

### Stage 8 (Queue)

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `pipeline_state` | WHERE task_id = ? | concept_id, youtube_seo_id, video_output_id |
| `concepts` | WHERE id = concept_id | video_type |
| `youtube_seo` | WHERE id = youtube_seo_id | title, description, tags |
| `video_output` | WHERE id = video_output_id | local_video_path, final_duration_seconds |

**Internal work:**
1. Verify local video file exists at `video_output.local_video_path`.
2. Insert into `video_queue` with status='ready'.
3. Send Telegram notification with title, duration, local path, and upload instructions (`node scripts/publish-video.mjs <task_id>`).

**Writes to DB:**

| When | Table | What |
|---|---|---|
| Queue row created | `video_queue` | INSERT (task_id, title, video_type, local_video_path, video_url=NULL, youtube_seo as JSONB, status='ready') |

**On error:** Throws. On restart, checks if `video_queue` row already exists (UNIQUE on task_id) — upserts if so.
**On success:** Launcher marks `video_pipeline_runs` stage_id='queue' as completed. **Pipeline ends here.**

---

### Stage 9 — REMOVED

YouTube upload is no longer a pipeline stage. It's handled by `publish-video.mjs` on demand.

---

### Publish Script (`publish-video.mjs`) — Separate, On-Demand

Not a pipeline stage. Run manually: `node scripts/publish-video.mjs <task_id>`

**Reads from DB:**

| Table | Query | What |
|---|---|---|
| `video_queue` | WHERE task_id = ? AND status = 'ready' | local_video_path, video_url, youtube_seo, video_type |

**Work:**
1. Read video from `local_video_path` (or `video_url` in future when remote storage is used).
2. Upload to YouTube as unlisted.
3. Add to playlist.
4. Run per-video feedback analysis.
5. Update feedback collection counters.

**Writes to DB:**

| When | Table | What |
|---|---|---|
| Upload success | `video_queue` | UPDATE status='uploaded', youtube_video_id, uploaded_at |
| Upload success | `video_output` | UPDATE video_url (YouTube URL — not storage URL, this is the public YouTube link) |
| Feedback | `pipeline_feedback` | INSERT approval record |
| Counters | `pipeline_settings` | UPDATE feedback_collection_completed counter |

---

## Stage Function Signature Changes

### Before (current)
```js
export async function runStage2(taskId, tracker, state = {}) {
  // reads from state object
  const { concept } = state;
  // ... does work ...
  // returns new state
  return { ...state, scenes, episodeNumber, youtube_seo, script, videoType, artStyle };
}
```

### After (new)
```js
export async function runStage2(taskId, tracker) {
  // reads everything from DB
  const { concept_id } = await getPipelineState(taskId);
  const concept = await getConcept(concept_id);
  // ... does work ...
  // writes to DB, returns nothing
  await insertScenes(taskId, scenes);
  await updatePipelineState(taskId, { youtube_seo_id: seoId, episode_number: epNum });
}
```

Every stage:
- Takes `(taskId, tracker)` — no `state` parameter
- Reads inputs from DB using `taskId` to find `pipeline_state`, then follows FKs
- Writes outputs to DB
- Returns nothing (or throws on error)

---

## Launcher Script Changes

### Before
```js
let pipelineState = { taskId, concept };
for (const stageNum of stageOrder) {
  pipelineState = await stageFn(taskId, tracker, pipelineState) || pipelineState;
}
```

### After
```js
for (const stageNum of stageOrder) {
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId, stage_id: STAGE_NUM_TO_ID[stageNum], status: 'running', started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage_id' });

  try {
    await stageFn(taskId, tracker);  // no state passed, no state returned
    await sb.from('video_pipeline_runs').update({
      status: 'completed', completed_at: new Date().toISOString(),
    }).eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
  } catch (err) {
    await sb.from('video_pipeline_runs').update({
      status: 'failed', error: err.message, completed_at: new Date().toISOString(),
    }).eq('task_id', taskId).eq('stage_id', STAGE_NUM_TO_ID[stageNum]);
    throw err;
  }
}
```

Key changes:
- No `pipelineState` variable — stages are self-sufficient
- No state restoration logic needed for mid-pipeline restarts (each stage reads from DB)
- The `state = {}` parameter and `return { ...state, ... }` pattern is eliminated from all stages
- Both launcher scripts (`launch-pipeline-from-story.mjs` and `run-1b-and-launch.mjs`) can be unified since the pipeline loop is now identical

### Resume logic

When restarting a pipeline mid-way, the launcher determines which stage to resume from by querying completed stages:

```js
// Determine resume point
const { data: completedStages } = await sb
  .from('video_pipeline_runs')
  .select('stage_id')
  .eq('task_id', taskId)
  .eq('status', 'completed');
const completedSet = new Set((completedStages || []).map(r => r.stage_id));

for (const stageNum of stageOrder) {
  const stageId = STAGE_NUM_TO_ID[stageNum];
  if (completedSet.has(stageId)) {
    console.log(`  ⏭️  Stage ${stageNum} (${stageId}) already completed — skipping`);
    continue;
  }
  // run stage...
}
```

Individual stages also have their own internal resume logic (e.g., Stage 2 skips already-approved scenes, Stage 4 skips already-illustrated scenes) so even if a stage is re-entered after a crash mid-stage, it picks up where it left off.

### Cost tracking

The `tracker` object (from `lib/cost-tracker.mjs`) is passed to each stage. Stages call `tracker.addCost(stageNum, amount)` internally after each billable API call (Claude, Imagen, Wan, ElevenLabs). The launcher flushes accumulated costs to `video_pipeline_runs.cost_usd` after each stage:

```js
await tracker.flush(stageNum);
// This writes the accumulated cost for this stage to the DB row
```

This pattern is unchanged from the current implementation — the cost tracking does not depend on pipeline_state JSONB.

---

## Storage Changes

### New uploads needed

| Stage | What | Bucket | Path pattern |
|---|---|---|---|
| Stage 6 | Audio MP3s | `scenes` | `{task_id}/scene_01_audio.mp3` |

Currently Stage 6 writes audio only to local `/tmp`. Must add upload to Supabase Storage so Stage 7 can download on restart.

### Existing uploads (no change)

| Stage | What | Bucket | Path pattern |
|---|---|---|---|
| Stage 3 | Character reference images | `characters` | `{charId}/v{version}.png` |
| Stage 3 | Episode-specific character images | `characters` | `{charId}/ep_{taskId}.png` |
| Stage 4 | Scene images | `scenes` | `{task_id}/scene_01_image.png` |
| Stage 5 | Scene animations | `scenes` | `{task_id}/scene_01_anim.mp4` |

### NOT uploaded (stays local)

| Stage | What | Path |
|---|---|---|
| Stage 7 | Final assembled video | `output/{taskId}/final.mp4` |

Final videos exceed Supabase free tier 50MB limit. Stored in persistent local `output/` directory (not `/tmp`). `video_output.video_url` column exists for future remote storage migration.

---

## Migration SQL

**IMPORTANT: Migration strategy is CREATE-FIRST, DROP-LAST.**

The migration is split into two phases:
- **Phase 1 (additive):** Create all new tables, add new columns. Can be run while old code is still running. No breakage.
- **Phase 2 (destructive):** Drop old tables/columns. Run ONLY after ALL stage rewrites are complete and tested. This is irreversible.

**Prerequisite:** The `update_updated_at_column()` trigger function must already exist. It is defined in `migrations/001_create_tables.sql`. If running on a fresh database, run that migration first.

**Prerequisite:** `video_pipeline_runs` must have a UNIQUE constraint on `(task_id, stage_id)` for the launcher's `.upsert({ onConflict: 'task_id,stage_id' })` to work. If this constraint does not exist, Phase 1 adds it.

### Phase 1: Additive (safe to run immediately)

```sql
-- ============================================================
-- Pipeline Schema Rewrite — Phase 1 (Additive)
-- Run this BEFORE rewriting any stage code.
-- ============================================================

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

-- 4. pipeline_state table (FK hub)
CREATE TABLE IF NOT EXISTS pipeline_state (
  task_id           UUID          PRIMARY KEY,
  concept_id        UUID          REFERENCES concepts(id),
  youtube_seo_id    UUID          REFERENCES youtube_seo(id),
  video_output_id   UUID          REFERENCES video_output(id),
  episode_number    INTEGER,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Auto-update trigger for pipeline_state.updated_at
-- Depends on update_updated_at_column() from migrations/001_create_tables.sql
DROP TRIGGER IF EXISTS pipeline_state_updated_at ON pipeline_state;
CREATE TRIGGER pipeline_state_updated_at
  BEFORE UPDATE ON pipeline_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. scenes table (will replace scene_assets after Phase 2)
CREATE TABLE IF NOT EXISTS scenes (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID          NOT NULL,
  scene_number          INTEGER       NOT NULL,
  speaker               TEXT,
  emotion               TEXT,
  text                  TEXT,
  visual_description    TEXT,
  characters            TEXT[]        DEFAULT '{}',
  script_approved       BOOLEAN       NOT NULL DEFAULT false,
  image_url             TEXT,
  prompt_used           TEXT,
  image_status          TEXT          NOT NULL DEFAULT 'pending' CHECK (image_status IN ('pending', 'completed', 'failed')),
  image_approved        BOOLEAN       NOT NULL DEFAULT false,
  animation_url         TEXT,
  animation_status      TEXT          NOT NULL DEFAULT 'pending' CHECK (animation_status IN ('pending', 'completed', 'failed')),
  animation_approved    BOOLEAN       NOT NULL DEFAULT false,
  audio_url             TEXT,
  enhanced_text         TEXT,
  audio_status          TEXT          NOT NULL DEFAULT 'pending' CHECK (audio_status IN ('pending', 'completed', 'failed')),
  audio_approved        BOOLEAN       NOT NULL DEFAULT false,
  environment           TEXT,
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

-- 8. Ensure UNIQUE constraint on video_pipeline_runs(task_id, stage_id) for upsert
-- This may already exist from prior usage. DO NOTHING on conflict.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_pipeline_runs_task_id_stage_id_key'
  ) THEN
    ALTER TABLE video_pipeline_runs ADD CONSTRAINT video_pipeline_runs_task_id_stage_id_key UNIQUE (task_id, stage_id);
  END IF;
END $$;
```

### Phase 2: Destructive (run ONLY after all stages are rewritten and tested)

```sql
-- ============================================================
-- Pipeline Schema Rewrite — Phase 2 (Destructive)
-- Run ONLY after ALL stage rewrites are complete and tested.
-- This is IRREVERSIBLE — existing pipeline state data will be lost.
-- ============================================================

-- WARNING: This destroys all data in scene_assets and pipeline_state JSONB.
-- Any in-progress pipelines using the old schema will break.
-- Ensure no pipelines are running before executing.

-- 1. Drop pipeline_state JSONB column from video_pipeline_runs
ALTER TABLE video_pipeline_runs DROP COLUMN IF EXISTS pipeline_state;

-- 2. Drop old scene_assets table (replaced by scenes table)
DROP TABLE IF EXISTS scene_assets;

-- 3. Drop dead supabase_thumbnail_path column from video_queue
-- (Stage 8 no longer writes thumbnails; column was from the old schema)
ALTER TABLE video_queue DROP COLUMN IF EXISTS supabase_thumbnail_path;
```

### Optional: Data migration for existing videos

If you need to preserve data from existing completed videos (not required for new pipelines):

```sql
-- Migrate scene_assets data into scenes table for existing videos.
-- Only migrates asset URLs and status — scene content (text, speaker, etc.)
-- was in pipeline_state JSONB and would need manual extraction.
INSERT INTO scenes (task_id, scene_number, image_url, animation_url, prompt_used, image_status, created_at)
SELECT video_id, scene_number, image_url, animation_url, prompt_used, status, created_at
FROM scene_assets
ON CONFLICT (task_id, scene_number) DO NOTHING;
```

---

## Implementation Order

**Strategy: additive migration first, dual-write during transition, destructive migration last.**

This avoids breaking anything at any point. The key technique is **dual-writing**: each rewritten stage writes to BOTH the new tables AND the old `pipeline_state` JSONB, so un-rewritten downstream stages can still read from the old format. Once all stages are rewritten, the old writes are removed.

### Dual-write pattern

During the transition, a rewritten stage does both:

```js
// NEW: write to proper tables (permanent)
await insertScenes(taskId, scenes);
await insertYoutubeSeo({ title, description, tags });
await updatePipelineState(taskId, { youtube_seo_id: seoId, episode_number: epNum });

// TEMPORARY dual-write: also write old format so un-rewritten downstream stages still work
// Remove this block once the next stage (Stage 3) is also rewritten.
await sb.from('video_pipeline_runs').upsert({
  task_id: taskId,
  stage_id: 'script',
  pipeline_state: { scenes, episodeNumber, youtube_seo },
}, { onConflict: 'task_id,stage_id' });
```

Similarly, a rewritten stage should **read from new tables first, fall back to old JSONB** during transition:

```js
// NEW: read from proper table
let concept = null;
const ps = await getPipelineState(taskId);
if (ps?.concept_id) {
  concept = await getConcept(ps.concept_id);
}

// TEMPORARY fallback: read from old pipeline_state JSONB if new table is empty
// (because Stage 1 hasn't been rewritten yet)
// Remove this block once Stage 1 is rewritten.
if (!concept) {
  const { data } = await sb.from('video_pipeline_runs')
    .select('pipeline_state')
    .eq('task_id', taskId).eq('stage_id', 'concept').single();
  concept = data?.pipeline_state?.concept;
}
```

### When to remove dual-writes

Each stage's dual-write can be removed once its **immediate downstream consumer** is also rewritten:

| Stage rewritten | Dual-write needed for | Remove dual-write when |
|---|---|---|
| Stage 1 | Stage 2 (reads concept from old JSONB) | Stage 2 is rewritten |
| Stage 2 | Stage 3 (reads `script` from old state), Stage 4 (reads scenes) | Stage 3 is rewritten |
| Stage 3 | Stage 4 (reads characterMap from old state), Stage 6 (reads characterVoiceMap) | Stage 6 AND Stage 4 are rewritten |
| Stage 6 | Stage 7 (reads sceneAudioPaths from old state) | Stage 7 is rewritten |
| Stage 4 | Stage 5 (reads sceneImagePaths from old state) | Stage 5 is rewritten |
| Stage 5 | Stage 7 (reads sceneAnimPaths from old state) | Stage 7 is rewritten |
| Stage 7 | Stage 8 (reads finalVideoPath from old state) | Stage 8 is rewritten |
| Stage 8 | publish-video.mjs (reads from video_queue — already DB-based) | No dual-write needed |

### Phase A: Foundation (no breakage to existing code)

1. **Run Phase 1 migration SQL** — creates all new tables and columns. Old code continues to work because nothing is removed yet.

2. **Create shared DB helper (`lib/pipeline-db.mjs`)** — all stages will use these instead of raw Supabase queries. Required exports:

```js
// Read helpers
getPipelineState(taskId)           → { task_id, concept_id, youtube_seo_id, video_output_id, episode_number }
getConcept(conceptId)              → { id, title, theme, synopsis, characters, outline, art_style, video_type }
getYoutubeSeo(seoId)               → { id, title, description, tags }
getVideoOutput(outputId)           → { id, local_video_path, video_url, final_duration_seconds }
getScenes(taskId)                  → [{ scene_number, speaker, emotion, text, ... }] ordered by scene_number
getScene(taskId, sceneNumber)      → single scene row
getEpisodeCharacters(taskId)       → [{ character_name, voice_id, image_prompt, ... }] where status='approved'
getEpisodeCharacter(taskId, name)  → single episode_character row

// Write helpers
insertConcept({ title, theme, ... })                        → concept_id
insertPipelineState(taskId, conceptId)                       → void
updatePipelineState(taskId, fields)                          → void (partial update)
insertScenes(taskId, scenesArray)                            → void (bulk insert)
updateScene(taskId, sceneNumber, fields)                     → void (partial update)
insertYoutubeSeo({ title, description, tags })               → seo_id
insertEpisodeCharacter(taskId, { character_name, ... })      → void
insertVideoOutput({ local_video_path, ... })                 → video_output_id
updateVideoOutput(outputId, fields)                          → void
```

3. **Create `lib/parse-claude-json.mjs`** — shared JSON fence-stripping + parsing:
```js
// Strips markdown fences (```json ... ```) and parses JSON.
// Throws with descriptive error if parsing fails, including first 200 chars of raw text.
parseClaudeJSON(rawText, context = '')  → parsed object
```

4. **Create `lib/character-approval.mjs`** — extracted from Stage 1 and Stage 1B:
```js
// Interactive character list approval via Telegram.
// Loops until user approves — allows adding/removing characters.
// Returns the approved character list (string array, lowercased).
approveCharacterList(characters, callbackPrefix)  → string[]
```

5. **Add `uploadSceneAudio()` to `lib/storage.mjs`**:
```js
// Uploads scene audio MP3 to Supabase Storage.
// Pattern: scenes/{videoId}/scene_01_audio.mp3
// Follows same pattern as existing uploadSceneImage() and uploadSceneAnimation().
uploadSceneAudio({ videoId, sceneNumber, buffer })  → storagePath (string)
```

### Phase B: Stage rewrites (one at a time, test each, dual-write during transition)

Each step below means: rewrite the stage to read from new tables (with old fallback), write to new tables (with old dual-write), and test end-to-end. The launcher continues to pass `state` during this phase — rewritten stages simply ignore it and read from DB instead.

6. **Rewrite Stage 1 / 1B** — write to `concepts` + `pipeline_state` tables. Dual-write: also write concept to old `pipeline_state` JSONB so old Stage 2 can read it.

7. **Rewrite Stage 2** — read concept from new `concepts` table (fallback to old JSONB). Write to `scenes` + `youtube_seo` tables. Dual-write: also write scenes/youtube_seo to old JSONB so old Stage 3 can read it. **Remove Stage 1's dual-write** (Stage 2 now reads from new tables).

8. **Rewrite Stage 3** — read from `concepts` + `scenes` tables. Write to `episode_characters` + `character_library`. Dual-write: also write characterMap/characterVoiceMap to old state return so old Stage 4/6 can read it. **Remove Stage 2's dual-write for `script`** (Stage 3 now reads character names from `concepts.characters`).

9. **Rewrite Stage 6** — read from `scenes` + `episode_characters` tables. Upload audio to storage. Write to `scenes` table (audio_url, enhanced_text, audio_status). Dual-write: also return sceneAudioPaths in old state format so old Stage 7 can read it. **Remove Stage 3's dual-write for characterVoiceMap** (Stage 6 now reads from `episode_characters`).

10. **Rewrite Stage 4** — read from `scenes` + `episode_characters` tables. Write to `scenes` table (image_url, image_status). Dual-write: also return sceneImagePaths in old state format so old Stage 5 can read it. **Remove Stage 3's dual-write for characterMap** (Stage 4 now reads from `episode_characters`).

11. **Rewrite Stage 5** — read from `scenes` table (image_url for Wan input). Write to `scenes` table (animation_url, animation_status). Dual-write: also return sceneAnimPaths so old Stage 7 can read it. **Remove Stage 4's dual-write** (Stage 5 now reads image_url from `scenes` table).

12. **Rewrite Stage 7** — read from `scenes` table (animation_url, audio_url, image_url). Download all from storage. Write to `video_output` table. Dual-write: also return finalVideoPath so old Stage 8 can read it. **Remove Stage 5 and Stage 6 dual-writes** (Stage 7 now reads everything from `scenes` table).

13. **Rewrite Stage 8** — read from `pipeline_state` FKs → `youtube_seo`, `video_output`, `concepts`. Write to `video_queue`. **Remove Stage 7's dual-write** (Stage 8 now reads from `video_output` table). **Remove Stage 2's remaining dual-write for youtube_seo** (Stage 8 now reads from `youtube_seo` table).

14. **Remove Stage 9** — delete `stage-09-publish.mjs`, remove from imports and stage order in `lib/stage-ids.mjs`.

15. **Rewrite launcher scripts** — remove state passing entirely (all dual-writes are now removed). Simplify to `await stageFn(taskId, tracker)`. Unify both launchers. Add resume logic (see Launcher Script Changes section).

16. **Update `lib/pipeline-utils.mjs`** — `resetSceneForRegeneration()` needs two changes: (a) query `scenes` table instead of `scene_assets`, (b) remove the code that reads/writes `video_pipeline_runs.pipeline_state` JSONB (that column will be dropped).

### Phase C: Cleanup (only after all stages tested end-to-end with NO dual-writes)

17. **Remove all old-format fallback reads** from every stage (the `if (!concept) { read from old JSONB }` blocks).

18. **Run Phase 2 migration SQL** — drops `scene_assets`, drops `pipeline_state` JSONB column, drops `supabase_thumbnail_path`. **Only safe after step 17** — no code should reference these anymore.

19. **Delete or archive episode-specific scripts** that reference old schema (see Files That Need Changes).

20. **Update documentation** — `docs/pipeline-flowchart.md`, `SPEC.md`.

### Summary: at no point is the pipeline broken

| After step | Old stages work? | New stages work? | Pipeline runs? |
|---|---|---|---|
| Phase A (foundation) | Yes (nothing changed) | N/A | Yes |
| Step 6 (Stage 1 rewritten) | Yes (dual-write feeds them) | Yes (reads/writes new tables) | Yes |
| Steps 7-13 (all stages rewritten) | Yes (but unused) | Yes | Yes |
| Step 15 (launchers rewritten) | N/A (not called) | Yes | Yes |
| Step 17 (fallbacks removed) | Would break if called | Yes | Yes |
| Step 18 (Phase 2 migration) | Would break | Yes | Yes |

---

## Files That Need Changes

### Stage files (core rewrites)
- `stages/stage-00-research.mjs` — minor: no state changes needed, but update Stage 1 call
- `stages/stage-01-concept-select.mjs` — rewrite: write to concepts + pipeline_state tables
- `stages/stage-01b-story-intake.mjs` — rewrite: write to concepts + pipeline_state tables
- `stages/stage-02-script-gen.mjs` — rewrite: read concept from DB, write to scenes + youtube_seo tables
- `stages/stage-03-character-prep.mjs` — rewrite: read from DB, write to episode_characters
- `stages/stage-04-illustrate.mjs` — rewrite: read from DB, write to scenes table
- `stages/stage-05-animate.mjs` — rewrite: read from DB, write to scenes table
- `stages/stage-06-voice.mjs` — rewrite: read from DB, upload audio to storage, write to scenes table
- `stages/stage-07-assemble.mjs` — rewrite: read from DB, download from storage, write to video_output
- `stages/stage-08-review.mjs` — rewrite: read from DB, write to video_queue
- `stages/stage-09-publish.mjs` — DELETE (functionality moved to publish-video.mjs)

### Launcher scripts (simplify + unify)
- `scripts/launch-pipeline.mjs` — remove state passing (this is the one spawned by Stage 1 as a detached process)
- `scripts/launch-pipeline-from-story.mjs` — remove state passing, remove state restoration logic, add resume-from-DB logic
- `scripts/run-1b-and-launch.mjs` — remove state passing. Consider unifying with `launch-pipeline-from-story.mjs` since the loop is now identical.

### Episode-specific scripts (reference old schema — delete or update)

These scripts directly reference `pipeline_state` JSONB and/or `scene_assets`. After Phase 2 migration, they will break. Most are one-off scripts for specific episodes and can likely be deleted:

- `scripts/rerun-stage7.mjs` — reads `pipeline_state`
- `scripts/rerun-stage7-ep04.mjs` — reads `pipeline_state`
- `scripts/rerun-stage8-9-ep04.mjs` — reads `pipeline_state`
- `scripts/rerun-stage8-9-ep06.mjs` — reads `pipeline_state`
- `scripts/resume-ep02-stage4.mjs` — reads `pipeline_state`
- `scripts/rebuild-ep01.mjs` — reads `pipeline_state` heavily
- `scripts/run-ep02-redo-tts-assemble.mjs` — likely references old schema
- `scripts/inspect-ep03-scenes.mjs` — reads `pipeline_state`
- `scripts/patch-ep03-state.mjs` — directly patches `pipeline_state` JSONB
- `scripts/check-ep03-state.mjs` — reads `pipeline_state`
- `scripts/fix-and-launch-ep03.mjs` — references `pipeline_state`
- `scripts/seed-ep03-tiny-guardian.mjs` — references `pipeline_state`
- `scripts/run-stage4-ep03.mjs` — reads `pipeline_state` from stage 3
- `scripts/run-ep02-pipeline.mjs` — references old state passing
- `scripts/run-ep03-tara.mjs` — references old state passing
- `scripts/run-birthday-story.mjs` — references old state passing
- `scripts/run-db-migration.mjs` — hardcodes `scene_assets` in expected tables list (must update to `scenes`)

**Recommendation:** Archive all episode-specific scripts to an `scripts/archive/` directory. They were one-off debugging/rerun tools. In the new model, resume is built into the launcher via DB state, making these scripts unnecessary.

### Library files (new + modified)
- `lib/pipeline-db.mjs` — NEW: shared DB helper functions for all stages (see Implementation Order for full function list)
- `lib/character-approval.mjs` — NEW: extracted from Stage 1 and Stage 1B (currently duplicated ~70 lines each)
- `lib/parse-claude-json.mjs` — NEW: shared JSON fence-stripping + parsing (currently duplicated 6+ times as `text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(); JSON.parse(text)`)
- `lib/storage.mjs` — add `uploadSceneAudio({ videoId, sceneNumber, buffer })` function following the same pattern as existing `uploadSceneImage()`
- `lib/pipeline-utils.mjs` — `resetSceneForRegeneration()` needs TWO changes: (a) query `scenes` table instead of `scene_assets` (line 33: `.from('scene_assets')` → `.from('scenes')`), (b) remove lines 44-84 that read/write `video_pipeline_runs.pipeline_state` JSONB column (that column is dropped in Phase 2). The scene reset logic is now just: `UPDATE scenes SET image_status='pending', image_url=NULL WHERE task_id=? AND scene_number=?`
- `lib/stage-ids.mjs` — remove stage 9 ('publish') mapping. Verify that `STAGE_ORDER` array matches the new order: `['concept', 'script', 'characters', 'tts', 'illustrate', 'animate', 'assemble', 'queue']`
- `scripts/publish-video.mjs` — add write to `video_output.video_url` after successful YouTube upload (currently only writes to `video_queue`)

### Migration files
- `supabase/migrations/YYYYMMDD_pipeline_schema_rewrite_phase1.sql` — Phase 1 (additive) from this doc
- `supabase/migrations/YYYYMMDD_pipeline_schema_rewrite_phase2.sql` — Phase 2 (destructive) from this doc

### Documentation
- `docs/pipeline-flowchart.md` — update to reflect new schema and stage contracts
- `SPEC.md` — update table schemas and data flow documentation
