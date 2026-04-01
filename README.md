# YouTube AI Pipeline — @tinytamiltales

Automated Tamil kids animated story production pipeline for [Tiny Tamil Tales](https://www.youtube.com/@tinytamiltales).

Built by **Ash** (Zolvra engineering agent) from Rex's SPEC.md.

---

## Pipeline Overview

| Stage | Name | Human Gate? | Cost |
|-------|------|-------------|------|
| 1B | Story Intake | ✅ Darl | $0 |
| 2 | Script Generation | ✅ Darl | ~$0.01 |
| 3 | Character Prep | Auto (feedback mode: ✅) | $0 |
| 6 | Tamil Voice (TTS) | Auto (feedback mode: ✅) | ~$0.72 |
| 4 | Scene Illustration | Auto (feedback mode: ✅) | ~$0.04 |
| 5 | Animation (Wan 2.6) | Auto (feedback mode: ✅) | ~$1.40 |
| 7 | Assembly (ffmpeg) | Auto (feedback mode: ✅) | $0 |
| 8 | Human Review | ✅ Darl | $0 |

Stage order: **1B → 2 → 3 → 6 → 4 → 5 → 7 → 8** (TTS runs before illustration so voice timing informs scene composition).

**Estimated cost per video: ~$2.16**
**Budget target: $8 | Hard cap: $10 (pipeline halts)**

---

## Quick Start

### 1. Install dependencies
```bash
cd streams/youtube && npm install
```

### 2. Run database migration
```bash
node scripts/run-db-migration.mjs
```

### 3. Seed settings + characters
```bash
node scripts/seed-pipeline-settings.mjs
node scripts/seed-character-library.mjs
```

### 4. Test all API connections
```bash
node scripts/test-connections.mjs
```

### 5. Launch the pipeline from a story
```bash
node scripts/launch-pipeline-from-story.mjs <story-file> [short|long] [task_id]
# Or from stdin:
cat story.txt | node scripts/launch-pipeline-from-story.mjs - [short|long]
```

This is the single entry point. Pass `[short|long]` for video format (default: short). Pass an existing `task_id` to resume a crashed pipeline.

---

## Directory Structure

```
streams/youtube/
├── stages/
│   ├── stage-01b-story-intake.mjs   # Accept story text, create task
│   ├── stage-02-script-gen.mjs      # Claude API → JSON script → Telegram review
│   ├── stage-03-character-prep.mjs  # Resolve characters from library
│   ├── stage-06-voice.mjs           # ElevenLabs TTS per line
│   ├── stage-04-illustrate.mjs      # Scene images via Google AI Imagen
│   ├── stage-05-animate.mjs         # Wan 2.6 image-to-video per scene
│   ├── stage-07-assemble.mjs        # ffmpeg assembly
│   └── stage-08-review.mjs          # Upload unlisted, notify via Telegram
├── lib/
│   ├── pipeline-db.mjs         # DB helpers (concepts, scenes, video_output, etc.)
│   ├── parse-claude-json.mjs   # Robust JSON extraction from Claude responses
│   ├── character-approval.mjs  # Character review + approval flow
│   ├── supabase.mjs            # Supabase client singleton
│   ├── settings.mjs            # getSetting() / setSetting()
│   ├── cost-tracker.mjs        # CostTracker class + BudgetCapExceededError
│   ├── retry.mjs               # withRetry() with exponential backoff
│   ├── image-gen.mjs           # Google AI Imagen wrapper
│   ├── wan.mjs                 # Wan 2.6 video generation wrapper
│   ├── tts.mjs                 # ElevenLabs TTS + SSML builder
│   ├── tts-takes.mjs           # 2-take generation + auto-select
│   ├── ffmpeg.mjs              # ffmpeg assembly helpers
│   ├── storage.mjs             # Supabase Storage helpers
│   ├── youtube.mjs             # YouTube Data API wrapper
│   ├── telegram.mjs            # Telegram bot helpers
│   ├── feedback-engine.mjs     # Feedback analysis + prompt updater
│   ├── stage-ids.mjs           # Stage ID constants
│   └── ...                     # Additional helpers (bgm, sfx, voice-config, etc.)
├── scripts/
│   ├── launch-pipeline-from-story.mjs  # Single launcher (main entry point)
│   ├── run-db-migration.mjs
│   ├── seed-pipeline-settings.mjs
│   ├── seed-character-library.mjs
│   ├── test-connections.mjs
│   ├── publish-video.mjs
│   ├── pull-channel-analytics.mjs
│   ├── download-audio.mjs
│   ├── download-sfx.mjs
│   └── archive/                     # 34 archived scripts
├── supabase/migrations/
│   ├── 20260326_rename_video_path_col.sql
│   ├── 20260327_add_stage_id_column.sql
│   ├── 20260327_drop_stage_integer_col.sql
│   ├── 20260328_pipeline_schema_rewrite_phase1.sql  # New tables (run)
│   └── 20260328_pipeline_schema_rewrite_phase2.sql  # Drop old tables (pending)
├── migrations/
│   └── 001_create_tables.sql
├── .env                        # Secrets (gitignored)
├── .env.example                # Template
└── package.json
```

---

## Database Schema

Key tables:

| Table | Purpose |
|-------|---------|
| `concepts` | Story concepts and intake metadata |
| `scenes` | Per-scene script data (dialogue, actions, timing) |
| `youtube_seo` | Title, description, tags, thumbnail metadata |
| `episode_characters` | Characters assigned to an episode |
| `video_output` | Final rendered video paths and upload status |
| `pipeline_state` | Stage progress, cost tracking, error state |

---

## Telegram Approval

All pipeline approvals go through Telegram via Heimdall (dedicated approval bot with long-polling). The bot sends approve/reject buttons for each scene or asset, and `waitForTelegramResponse()` blocks until Darl responds.

**Approval surfaces:**
- Stage 2: Per-scene script approval (Telegram buttons)
- Stage 4: Per-scene image approval (Telegram photo + buttons, feedback mode)
- Stage 5: Per-scene animation approval (Telegram video + buttons, feedback mode)
- Stage 6: Per-scene voice approval (Telegram audio + buttons, feedback mode)
- Stage 8: YouTube upload notification (Telegram message)

---

## Feedback Collection Mode

For the **first 10 videos**, every automated stage (3-7) sends assets to Telegram for Darl's review. This builds the dataset to calibrate the AI systems.

After 10 videos, stages 3-7 run automatically with quality gates. Stages 1B, 2, and 8 remain human-gated **permanently**.

Settings controlling this:
```
feedback_collection_mode:      true/false
feedback_collection_target:    10
feedback_collection_completed: 0-N
```

---

## Budget Hard Cap

The pipeline tracks USD spend per stage in `pipeline_state.cost_usd`.

- **Target ($8):** Warning logged, pipeline continues
- **Hard cap ($10):** `BudgetCapExceededError` thrown, pipeline **halts immediately**

Never override the hard cap — it exists to protect from runaway API costs.

---

## Environment Variables

See `.env.example` for all required variables.

Key services:
- **Supabase** — Database + Storage
- **Google AI** — Scene image generation (Imagen)
- **Wan 2.6** — Video animation
- **ElevenLabs** — Tamil TTS (multilingual v2)
- **YouTube Data API** — Upload + publish
- **Pixabay** — Background music pool

---

*Built by Ash — Zolvra Engineering Agent*
*Spec authored by Rex — Zolvra Research Agent*
*Last updated: 2026-03-28*
