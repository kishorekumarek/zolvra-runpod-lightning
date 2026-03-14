# YouTube AI Pipeline — @tinytamiltales

Automated Tamil kids animated story production pipeline for [Tiny Tamil Tales](https://www.youtube.com/@tinytamiltales).

Built by **Ash** (Zolvra engineering agent) from Rex's SPEC.md.

---

## Pipeline Overview

| Stage | Name | Human Gate? | Cost |
|-------|------|-------------|------|
| 0 | Weekly Research | ❌ Cron | $0 |
| 1 | Concept Selection | ✅ Darl | $0 |
| 2 | Script Generation | ✅ Darl | ~$0.01 |
| 3 | Character Prep | Auto (feedback mode: ✅) | $0 |
| 4 | Scene Illustration | Auto (feedback mode: ✅) | ~$0.04 |
| 5 | Animation (Kling) | Auto (feedback mode: ✅) | ~$1.40 |
| 6 | Tamil Voice (TTS) | Auto (feedback mode: ✅) | ~$0.72 |
| 7 | Assembly (ffmpeg) | Auto (feedback mode: ✅) | $0 |
| 8 | Human Review | ✅ Darl | $0 |
| 9 | Publish + Feedback | ✅ Final confirmation | $0 |

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

### 5. Run weekly research (generates story concepts)
```bash
node stages/stage-00-research.mjs
```

### 6. Start pipeline (after concept approved in NEXUS)
```bash
node scripts/run-pipeline.mjs <task_id> [start_stage]
```

---

## Directory Structure

```
streams/youtube/
├── pipeline/
│   └── orchestrator.mjs        # Main entry — runs all stages in sequence
├── stages/
│   ├── stage-00-research.mjs   # Weekly cron: trends → story concepts
│   ├── stage-01-concept-select.mjs  # Wait for NEXUS approval, emit task_id
│   ├── stage-02-script-gen.mjs      # Claude API → JSON script → NEXUS review
│   ├── stage-03-character-prep.mjs  # Resolve characters from library
│   ├── stage-04-illustrate.mjs      # Scene images via Google AI Imagen
│   ├── stage-05-animate.mjs         # Kling image-to-video per scene
│   ├── stage-06-voice.mjs           # ElevenLabs TTS per line
│   ├── stage-07-assemble.mjs        # ffmpeg assembly
│   ├── stage-08-review.mjs          # Upload unlisted, await NEXUS approval
│   └── stage-09-publish.mjs         # Publish to YouTube + feedback loop
├── lib/
│   ├── supabase.mjs            # Supabase client singleton
│   ├── settings.mjs            # getSetting() / setSetting()
│   ├── cost-tracker.mjs        # CostTracker class + BudgetCapExceededError
│   ├── retry.mjs               # withRetry() with exponential backoff
│   ├── nexus-client.mjs        # NEXUS board via Supabase ops_tasks
│   ├── image-gen.mjs           # Google AI Imagen wrapper
│   ├── motion-params.mjs       # Kling motion type → params
│   ├── kling.mjs               # Kling API wrapper + polling
│   ├── tts.mjs                 # ElevenLabs TTS + SSML builder
│   ├── tts-takes.mjs           # 2-take generation + auto-select
│   ├── youtube.mjs             # YouTube Data API wrapper
│   ├── storage.mjs             # Supabase Storage helpers
│   ├── feedback-engine.mjs     # Feedback analysis + prompt updater
│   └── ffmpeg.mjs              # ffmpeg assembly helpers
├── scripts/
│   ├── run-db-migration.mjs    # Run SQL migrations
│   ├── seed-pipeline-settings.mjs   # Insert default settings
│   ├── seed-character-library.mjs   # Insert initial characters
│   ├── run-pipeline.mjs             # Manual pipeline trigger
│   └── test-connections.mjs         # Test all 6 APIs
├── migrations/
│   └── 001_create_tables.sql   # Full schema
├── cron/
│   ├── weekly-research.cron    # Mon 08:00 GST
│   └── cleanup-tmp.cron        # Daily midnight cleanup
├── .env                        # Secrets (gitignored)
├── .env.example                # Template
└── package.json
```

---

## NEXUS Integration

NEXUS is the Zolvra operations board. The pipeline writes directly to `ops_tasks` in Supabase — no separate API.

**Card types:**
- `story_proposal` — Stage 0 story concept (Darl picks one)
- `script_proposal` — Stage 2 script (Darl approves)
- `character_proposal` — New character request or prompt update
- `video_delivery` — Stage 8 final video for review
- `video_parent` — Parent card showing production progress
- `stage_review` — Feedback collection mode review card

---

## Feedback Collection Mode

For the **first 10 videos**, every automated stage (3–7) goes to NEXUS for Darl's review. This builds the dataset to calibrate the AI systems.

After 10 videos, stages 3–7 run automatically with quality gates. Stages 1, 2, and 8 remain human-gated **permanently**.

Settings controlling this:
```
feedback_collection_mode:      true/false
feedback_collection_target:    10
feedback_collection_completed: 0-N
```

---

## Budget Hard Cap

The pipeline tracks USD spend per stage in `video_pipeline_runs.cost_usd`.

- **Target ($8):** Warning logged, pipeline continues
- **Hard cap ($10):** `BudgetCapExceededError` thrown, pipeline **halts immediately**

Never override the hard cap — it exists to protect from runaway API costs.

---

## Environment Variables

See `.env.example` for all required variables.

Key services:
- **Supabase** — Database + Storage + NEXUS board
- **Google AI** — Scene image generation (Imagen)
- **kie.ai** — Kling video animation
- **ElevenLabs** — Tamil TTS (multilingual v2)
- **YouTube Data API** — Upload + publish
- **Pixabay** — Background music pool

---

## Cron Setup

```bash
# View current crontab
crontab -l

# Add weekly research job
crontab -e
# Add: 0 4 * * 1 cd /Users/friday/.openclaw/workspace/streams/youtube && node stages/stage-00-research.mjs >> /tmp/youtube-research.log 2>&1

# Add daily cleanup
# Add: 0 0 * * * find /tmp/zolvra-pipeline -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} + 2>/dev/null || true
```

---

*Built by Ash — Zolvra Engineering Agent*  
*Spec authored by Rex — Zolvra Research Agent*
