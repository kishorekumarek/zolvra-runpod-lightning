# RunPod Worker — Lightning LoRA Setup Guide

**Endpoint:** `q7t7gbsvpnnkv8`  
**Stack:** ComfyUI + WanVideo nodes + Lightning LoRA  
**Target:** ~35s/clip at 512×992 (vs ~485s without Lightning)

---

## 1. Model Files Required

Both files must be present on the worker **before the first job**. Use a RunPod network volume for fast iteration:

```
/workspace/ComfyUI/models/checkpoints/wan2.2-i2v-480p.safetensors
/workspace/ComfyUI/models/loras/Wan2.2-I2V-A14B-480P-Lightning-4step.safetensors
```

**Download the Lightning LoRA:**
```bash
huggingface-cli download lightx2v/Wan2.2-Lightning \
  Wan2.2-I2V-A14B-480P-Lightning-4step.safetensors \
  --local-dir /workspace/ComfyUI/models/loras/
```

> Use the **480P** checkpoint (`480P` in the filename). The 720P checkpoint needs higher VRAM and doesn't improve quality at our target resolutions.

---

## 2. ComfyUI Workflow — Critical Node Settings

These are the values that must be set in `workflow_lightning_i2v.json` (baked into the worker). They are **not** controlled by job input (see §3).

### KSampler (or WanVideoSampler)
```json
{
  "sampler_name": "lcm",
  "scheduler": "sgm_uniform",
  "steps": 4,
  "cfg": 1.0,
  "denoise": 1.0
}
```

### ModelSamplingWan (timestep shift)
```json
{
  "shift": 8.0,
  "base_shift": 0.5
}
```
> Without this node, 4-step LCM produces blurry/smeared I2V output.

### LoraLoader
```json
{
  "lora_name": "Wan2.2-I2V-A14B-480P-Lightning-4step.safetensors",
  "strength_model": 1.0,
  "strength_clip": 1.0
}
```
> LoRA strength must be **exactly 1.0** — partial application breaks the CFG-free schedule.

### WanImageToVideoCombined (I2V conditioning)
```json
{
  "width": "__TEMPLATE_WIDTH__",
  "height": "__TEMPLATE_HEIGHT__",
  "length": "__TEMPLATE_LENGTH__",
  "batch_size": 1
}
```
> `width`, `height`, and `length` are template-substituted from job input. All other params are fixed.

---

## 3. handler.py — What to Hard-Code vs What to Accept from Job Input

**Hard-code these** (do not allow caller to override):
```python
WORKFLOW_PARAMS = {
    "steps": 4,
    "cfg": 1.0,
    "sampler": "lcm",
    "scheduler": "sgm_uniform",
    "shift": 8.0,
    "lora": "Wan2.2-I2V-A14B-480P-Lightning-4step.safetensors",
}
```

**Accept these from job input** (template-substitute into the workflow JSON):
```python
ACCEPTED_INPUT_FIELDS = [
    "image_base64",     # raw base64, no data URI prefix
    "prompt",           # max 300 chars
    "negative_prompt",  # optional, has hardcoded default
    "width",            # must be 512 or 992
    "height",           # must be 992 or 512
    "length",           # 81 (≈5s) or 161 (≈10s). Default: 81
    "seed",             # -1 for random. Default: -1
]
# steps and cfg may arrive in input — silently ignore them (Lightning contract is fixed)
```

**Return shape** (must match exactly):
```json
{
  "video": "<raw base64 mp4, no data URI prefix>"
}
```

---

## 4. Startup Health Check (Recommended)

Add to the top of `handler.py` before the first job is accepted:

```python
import os, sys

LORA_PATH = "/workspace/ComfyUI/models/loras/Wan2.2-I2V-A14B-480P-Lightning-4step.safetensors"
BASE_MODEL_PATH = "/workspace/ComfyUI/models/checkpoints/wan2.2-i2v-480p.safetensors"

for path in [LORA_PATH, BASE_MODEL_PATH]:
    if not os.path.exists(path):
        print(f"FATAL: model file missing: {path}", file=sys.stderr)
        sys.exit(1)
```

This prevents the worker from silently accepting jobs and then failing mid-generation due to a missing model file.

---

## 5. Expected Performance

| Metric | Value |
|--------|-------|
| Cold start (network volume) | ~60–90s |
| Warm generation time | ~35s/clip |
| VRAM required | ~18GB (A100 40GB recommended) |
| Output resolution | 512×992 (9:16) or 992×512 (16:9) |
| Output length | 81 frames ≈ 5s @ 16fps |

---

## 6. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Blurry/smeared output | `ModelSamplingWan` node missing or `shift` wrong | Set `shift=8.0`, confirm node is connected |
| Output is a still frame | LoRA not loaded or `strength_model=0` | Check `LoraLoader` node, set strength to 1.0 |
| Job times out (>3 min) | Worker using standard sampler (not LCM) | Confirm `sampler_name: "lcm"` in KSampler |
| VRAM OOM | Wrong resolution or too many frames | Check width/height are 512/992; reduce `length` to 81 |
| `lcm` sampler not found | ComfyUI version too old | Update ComfyUI (needs ≥ 2024-11 build) |
