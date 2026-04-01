# RunPod Wan 2.2 Lightning I2V — Serverless Endpoint

Spec: `streams/shared/specs/84-173.md`  
Target: ~35s/clip (vs ~213s for existing `q7t7gbsvpnnkv8`)  
Method: Seko V1 two-stage Lightning LoRA on Wan 2.2 I2V 14B fp16

---

## Architecture

```
job input (image + prompt)
       ↓
  handler.py  (RunPod serverless)
       ↓  starts ComfyUI on cold start
  ComfyUI :8188  (internal)
       ↓  two-stage WanVideoWrapper workflow
  Stage 1: WanVideoSampler (high-noise LoRA, steps=2, T=1000→500)
  Stage 2: WanVideoSampler (low-noise LoRA, steps=2, T=500→0)
       ↓
  WanVideoVAEDecode → VHS_VideoCombine
       ↓
  base64 mp4 → handler returns to caller
```

Models are NOT baked into the image. They're read from the network volume at runtime:
- Volume: `bc74lndvht` (US-TX-3)
- Mount: `/workspace`
- Base models: `/workspace/ComfyUI/models/checkpoints/`
- LoRAs: `/workspace/ComfyUI/models/loras/wan2.2-i2v-lightning/`

---

## Prerequisites Before Building

### Step 1: Verify Base Models on Volume

Spin up a pod in US-TX-3 with volume `bc74lndvht` and check:

```bash
ls -lh /workspace/ComfyUI/models/checkpoints/wan2.2_i2v_*
```

Expected files (~28 GB each):
- `wan2.2_i2v_high_noise_14B_fp16.safetensors`
- `wan2.2_i2v_low_noise_14B_fp16.safetensors`

If missing, download from HuggingFace:
```bash
pip install -q huggingface_hub
huggingface-cli download \
  Wan-AI/Wan2.2-I2V-A14B \
  wan2.2_i2v_high_noise_14B_fp16.safetensors \
  wan2.2_i2v_low_noise_14B_fp16.safetensors \
  --local-dir /workspace/ComfyUI/models/checkpoints/ \
  --local-dir-use-symlinks False
```

Also check text encoder and CLIP vision:
```bash
ls /workspace/ComfyUI/models/text_encoders/umt5-xxl-enc-bf16.safetensors
ls /workspace/ComfyUI/models/clip_vision/clip_vision_h.safetensors
```
Download if missing (from `Wan-AI/Wan2.2-I2V-A14B` or `openai/clip-vit-large-patch14`).

### Step 2: Get forKJ.json from Volume

Copy the reference workflow from the volume:
```bash
scp -P <port> root@<ip>:/workspace/ComfyUI/models/loras/wan2.2-i2v-lightning/\
Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/\
Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-forKJ.json \
lightning_i2v.json
```

Then apply `{{PLACEHOLDER}}` tokens as documented in the existing `lightning_i2v.json`.
The current `lightning_i2v.json` is a **reconstructed template** — it may have different
node IDs than the real forKJ.json. The real file takes precedence.

---

## Build & Push

```bash
cd streams/youtube/runpod-lightning/

# Login to Docker Hub (zolvra account)
docker login

# Build and push
chmod +x build.sh
./build.sh v1.0.0

# GHCR fallback if Docker Hub unavailable:
# REGISTRY=ghcr.io ./build.sh v1.0.0
```

> ⚠️ Must be on linux/amd64 or use `--platform linux/amd64` (BuildKit).
> On Apple Silicon, BuildKit handles cross-compilation but CUDA layers are slow.
> Prefer a Linux build server for faster CI builds.

---

## Create RunPod Endpoint

After the image is pushed, create the serverless endpoint via GraphQL:

```bash
curl -s -X POST 'https://api.runpod.io/graphql?api_key=<RUNPOD_API_KEY>' \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { saveEndpoint(input: { name: \"wan-lightning-i2v-v1\", dockerImage: \"zolvra/runpod-wan-lightning-i2v:v1.0.0\", gpuIds: [\"AMPERE_48\", \"ADA_48\"], workersMin: 0, workersMax: 3, idleTimeout: 60, scalerType: \"QUEUE_DEPTH\", scalerValue: 1, executionTimeoutMs: 120000, networkVolumeId: \"bc74lndvht\", volumeMountPath: \"/workspace\", env: [] }) { id name status } }"
  }'
```

Record the returned `id` and add to `.env`:
```
RUNPOD_WAN_LIGHTNING_ENDPOINT_ID=<id>
```

---

## Handler Interface

### Input
```json
{
  "input": {
    "image_base64": "<raw base64, no data URI prefix>",
    "prompt": "a child waves at the camera, gentle motion",
    "negative_prompt": "optional, defaults to NSFW filter",
    "width": 512,
    "height": 992,
    "length": 81,
    "seed": -1
  }
}
```

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `image_base64` | ✅ | — | Raw base64 PNG/JPEG |
| `prompt` | ✅ | — | Max 300 chars |
| `negative_prompt` | ❌ | NSFW filter | — |
| `width` | ✅ | — | 512 or 992 |
| `height` | ✅ | — | 992 or 512 |
| `length` | ❌ | 81 | 81=~5s, 161=~10s |
| `seed` | ❌ | -1 (random) | — |

Hard-coded (not overridable): `steps=4 total (2/stage)`, `cfg=1.0`, `sampler=lcm`, `lora_strength=1.0`, `fps=16`

### Output
```json
{ "video": "<raw base64 mp4>" }
```
Or on error:
```json
{ "error": "<message>" }
```

---

## Testing

```bash
# Submit test job (requires jq, base64)
IMAGE_B64=$(base64 -i /path/to/test_image.png)

curl -s -X POST "https://api.runpod.ai/v2/<ENDPOINT_ID>/run" \
  -H "Authorization: Bearer <RUNPOD_API_KEY>" \
  -H "Content-Type: application/json" \
  -d "{\"input\": {\"image_base64\": \"${IMAGE_B64}\", \"prompt\": \"a child smiles and waves, smooth motion\", \"width\": 512, \"height\": 992, \"length\": 81}}"

# Poll status
curl -s "https://api.runpod.ai/v2/<ENDPOINT_ID>/status/<JOB_ID>" \
  -H "Authorization: Bearer <RUNPOD_API_KEY>" | jq .

# Decode output video when status == COMPLETED
curl -s "https://api.runpod.ai/v2/<ENDPOINT_ID>/status/<JOB_ID>" \
  -H "Authorization: Bearer <RUNPOD_API_KEY>" | jq -r '.output.video' | base64 -d > output.mp4
```

---

## Known Constraints

| Constraint | Status |
|-----------|--------|
| US-TX-3 GPU supply | Sometimes exhausted — check RunPod console before building endpoint |
| Base models on volume | **UNVERIFIED** — pod spawn failed during build (supply constraint). Manual check required |
| lightning_i2v.json | Template reconstruction — must be replaced with actual forKJ.json from volume |
| Docker Hub credentials | Not set up for `zolvra` account — use GHCR as fallback |
| Build machine | Must be linux/amd64 — not tested on Apple Silicon |

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Image definition, ComfyUI + WanVideoWrapper pre-installed |
| `handler.py` | RunPod serverless handler, full lifecycle management |
| `start_comfyui.sh` | Cold-start script: symlinks models, starts ComfyUI |
| `lightning_i2v.json` | Parameterised ComfyUI workflow template |
| `build.sh` | Build + push automation |
| `README.md` | This file |
