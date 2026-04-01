# RunPod Wan 2.2 Animation Provider — Technical Spec

**Ops step:** 161
**Author:** Ash
**Date:** 2026-03-30
**Status:** Draft

## Summary

Add RunPod serverless Wan 2.2 (with LoRA template) as a second animation provider alongside the existing kie.ai Wan 2.6. RunPod costs ~$0.02/clip vs $0.10/clip on kie.ai — an 80% cost reduction. Provider is switchable via `pipeline_settings` table.

---

## 1. RunPod Serverless API Shape

RunPod serverless endpoints use a standard submit/poll pattern:

### Submit Job

```
POST https://api.runpod.ai/v2/{RUNPOD_WAN_ENDPOINT_ID}/run
Authorization: Bearer {RUNPOD_API_KEY}
Content-Type: application/json

{
  "input": {
    "image_url": "<signed URL to scene image>",
    "prompt": "<animation prompt, max 300 chars>",
    "negative_prompt": "nsfw, violence, blood, scary, dark, horror",
    "num_frames": 81,
    "width": 720,
    "height": 1280,
    "guidance_scale": 5.0,
    "num_inference_steps": 30,
    "seed": -1
  }
}
```

**Response:**
```json
{ "id": "runpod-job-id-xxx", "status": "IN_QUEUE" }
```

### Poll Job Status

```
GET https://api.runpod.ai/v2/{RUNPOD_WAN_ENDPOINT_ID}/status/{job_id}
Authorization: Bearer {RUNPOD_API_KEY}
```

**Response (in progress):**
```json
{ "id": "xxx", "status": "IN_PROGRESS" }
```

**Response (completed):**
```json
{
  "id": "xxx",
  "status": "COMPLETED",
  "output": {
    "video_url": "https://..."
  }
}
```

**Response (failed):**
```json
{
  "id": "xxx",
  "status": "FAILED",
  "error": "error message"
}
```

### Resolution Mapping

| Video Type | Aspect Ratio | Width | Height | Frames | Duration |
|-----------|-------------|-------|--------|--------|----------|
| short     | 9:16        | 720   | 1280   | 81     | ~5s at 16fps |
| long      | 16:9        | 1280  | 720    | 81     | ~5s at 16fps |

> **Note:** Wan 2.2 generates ~5s clips (81 frames at 16fps) vs kie.ai Wan 2.6's 10s clips. Stage 7 (assembly) already handles variable clip durations, so no assembly changes needed. If 10s is required, we can set `num_frames: 161` but this doubles GPU time and cost — start with 81 frames and evaluate.

---

## 2. `lib/runpod-wan.mjs` Interface

New file. Mirrors `lib/wan.mjs` export surface exactly so Stage 5 can swap providers with minimal changes.

```js
// lib/runpod-wan.mjs — Wan 2.2 image-to-video via RunPod serverless

export async function submitWanJob({ imageUrl, prompt, aspectRatio, duration })
// Returns: string (RunPod job ID)
// - Reads RUNPOD_WAN_ENDPOINT_ID and RUNPOD_API_KEY from env
// - Appends negative_prompt (hardcoded NSFW filter)
// - Maps aspectRatio to width/height per table above
// - POSTs to /v2/{endpoint}/run
// - Returns response.id
// - Throws on missing env vars or non-200 response

export async function pollWanJob(jobId, maxWaitMs = 600000)
// Returns: string (video URL)
// - GETs /v2/{endpoint}/status/{jobId}
// - Poll interval: 10s (RunPod jobs are typically faster than kie.ai)
// - Terminal states: COMPLETED -> return output.video_url
//                    FAILED -> throw with error message
//                    CANCELLED -> throw
// - Timeout after maxWaitMs

export async function downloadWanVideo(url)
// Returns: Buffer
// - Identical to lib/wan.mjs implementation (fetch + arrayBuffer -> Buffer)
// - Can be shared, but keeping it in each file avoids coupling
```

### Key Differences from kie.ai (`lib/wan.mjs`)

| Aspect | kie.ai (wan.mjs) | RunPod (runpod-wan.mjs) |
|--------|-----------------|------------------------|
| Auth header | `Bearer {KIEAI_API_KEY}` | `Bearer {RUNPOD_API_KEY}` |
| Submit URL | `api.kie.ai/api/v1/jobs/createTask` | `api.runpod.ai/v2/{endpoint}/run` |
| Poll URL | `api.kie.ai/api/v1/jobs/recordInfo?taskId=` | `api.runpod.ai/v2/{endpoint}/status/{id}` |
| Job ID field | `data.data.taskId` | `id` |
| Success state | `data.data.state === 'success'` | `status === 'COMPLETED'` |
| Video URL | `JSON.parse(resultJson).resultUrls[0]` | `output.video_url` |
| Failure state | `state === 'fail'` | `status === 'FAILED'` |
| Poll interval | 15s | 10s |
| Input format | `{ model, input: { prompt, image_urls, ... } }` | `{ input: { image_url, prompt, width, height, ... } }` |
| Env vars | `KIEAI_API_KEY` | `RUNPOD_API_KEY`, `RUNPOD_WAN_ENDPOINT_ID` |

---

## 3. Changes to `stages/stage-05-animate.mjs`

### 3a. New Import Block (line 9)

Replace the single wan import with a provider-resolved import:

**Current (line 9):**
```js
import { submitWanJob, pollWanJob, downloadWanVideo } from '../lib/wan.mjs';
```

**New (lines 9-10):**
```js
import * as kieaiWan from '../lib/wan.mjs';
import * as runpodWan from '../lib/runpod-wan.mjs';
```

### 3b. Provider Resolution (new code after line 24)

Add a function to resolve which provider module to use:

```js
async function getAnimationProvider() {
  try {
    const provider = await getSetting('animation_provider');
    if (provider === 'runpod') return runpodWan;
  } catch {}
  return kieaiWan; // default: kie.ai
}
```

### 3c. `animateScene()` Changes (lines 211-255)

Modify `animateScene()` to use the resolved provider:

**Line 215-216 area — replace direct calls with provider calls:**

```js
// BEFORE:
const wanTaskId = await withRetry(
  () => submitWanJob({ imageUrl, prompt, aspectRatio }),
  ...
);
const videoUrl = await withRetry(
  () => pollWanJob(wanTaskId, 600000),
  ...
);
const videoBuffer = await downloadWanVideo(videoUrl);

// AFTER:
const wan = await getAnimationProvider();
const wanTaskId = await withRetry(
  () => wan.submitWanJob({ imageUrl, prompt, aspectRatio }),
  ...
);
const videoUrl = await withRetry(
  () => wan.pollWanJob(wanTaskId, 600000),
  ...
);
const videoBuffer = await wan.downloadWanVideo(videoUrl);
```

**Line 250 — provider-aware cost:**

```js
// BEFORE:
const cost = calcAnimationCost(1);

// AFTER:
const providerName = wan === runpodWan ? 'runpod' : 'kieai';
const cost = calcAnimationCost(1, providerName);
```

### 3d. Console Logging

Update the log at line 215 to show which provider is active:

```js
const providerLabel = wan === runpodWan ? 'RunPod Wan 2.2' : 'Wan 2.6 (kie.ai)';
console.log(`  Submitting ${providerLabel} job for scene ${scene.scene_number}...`);
```

No other files in the stage pipeline need changes.

---

## 4. Provider Switching Mechanism

### `pipeline_settings` table (primary, runtime-switchable)

| key | value | description |
|-----|-------|-------------|
| `animation_provider` | `"kieai"` (default) or `"runpod"` | Active animation backend |

**To switch:**
```sql
INSERT INTO pipeline_settings (key, value) VALUES ('animation_provider', 'runpod')
ON CONFLICT (key) DO UPDATE SET value = 'runpod';
```

Or via existing helper:
```js
import { setSetting } from '../lib/settings.mjs';
await setSetting('animation_provider', 'runpod');
```

### Fallback Order

1. Check `pipeline_settings.animation_provider`
2. If missing or query fails -> default to `kieai`
3. Env vars (`RUNPOD_API_KEY`, `RUNPOD_WAN_ENDPOINT_ID`) must be present when `runpod` is selected — throw clear error at job submit time if missing

### No Env Var Toggle

Provider selection is **not** controlled by env vars — only by the DB setting. Env vars supply credentials only. This keeps runtime switching possible without restarts and matches how other pipeline settings (budget, feedback mode) already work.

---

## 5. Cost Tracking Additions

### `lib/cost-tracker.mjs` Changes

**Add new rate constant (after line 76):**
```js
export const COST_RATES = {
  imagen_fast:     0.004,
  imagen_quality:  0.040,
  kling_v15_5s:    0.140,   // legacy name, used for kieai wan
  wan_kieai:       0.100,   // kie.ai Wan 2.6 per clip (actual rate)
  wan_runpod:      0.020,   // RunPod Wan 2.2 per clip
  elevenlabs_1000: 0.300,
};
```

> **Note:** The existing `kling_v15_5s: 0.140` rate is a legacy misnomer (we switched from Kling to Wan). The actual kie.ai rate is $0.10/clip. Add the correct named rates and deprecate `kling_v15_5s` in a follow-up cleanup.

**Update `calcAnimationCost()` (line 83):**
```js
// BEFORE:
export function calcAnimationCost(clipCount = 1) {
  return clipCount * COST_RATES.kling_v15_5s;
}

// AFTER:
export function calcAnimationCost(clipCount = 1, provider = 'kieai') {
  const rate = provider === 'runpod'
    ? COST_RATES.wan_runpod
    : COST_RATES.wan_kieai;
  return clipCount * rate;
}
```

### Cost Impact (per 9-scene short video)

| Provider | Rate/clip | 9 clips | Savings |
|----------|----------|---------|---------|
| kie.ai Wan 2.6 | $0.100 | $0.90 | — |
| RunPod Wan 2.2 | $0.020 | $0.18 | 80% |

---

## 6. Env Vars Required

Already in `.env` per task context:

```
RUNPOD_API_KEY=<api key>
RUNPOD_WAN_ENDPOINT_ID=<endpoint id>
```

No new env vars needed.

---

## 7. Implementation Checklist

1. [ ] Create `lib/runpod-wan.mjs` (3 exported functions mirroring `lib/wan.mjs`)
2. [ ] Update `stages/stage-05-animate.mjs` (provider resolution + dynamic dispatch)
3. [ ] Update `lib/cost-tracker.mjs` (new rates + provider param)
4. [ ] Insert `animation_provider` = `kieai` into `pipeline_settings` (safe default)
5. [ ] Test with one scene: `setSetting('animation_provider', 'runpod')` then run Stage 5
6. [ ] Validate cost logging in `video_pipeline_runs.cost_usd` reflects RunPod rate
7. [ ] Switch back to `kieai` and verify fallback still works

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| RunPod cold start latency (30-60s first request) | Already covered by `withRetry` + 600s poll timeout in Stage 5 |
| Wan 2.2 lower quality than Wan 2.6 | A/B test a few scenes before full switch; keep kie.ai as instant fallback |
| 5s clips vs 10s clips | Stage 7 assembly handles variable durations; may need `num_frames: 161` if 10s required |
| RunPod endpoint down | `getAnimationProvider()` defaults to kieai; manual `setSetting` to switch back |
| NSFW content from open-weight model | Hardcoded negative_prompt in submit; existing Telegram approval gate catches issues |

---

## 9. Out of Scope

- Auto-failover between providers (manual switch only for now)
- Per-scene provider selection
- Wan 2.2 LoRA fine-tuning configuration (uses endpoint's default template)
- Removing or deprecating `lib/wan.mjs` (keep both indefinitely)
