#!/bin/bash
# start_comfyui.sh — Called by handler.py during cold start.
# Sets up the model symlink and starts ComfyUI in the background.
# Exits 0 when ComfyUI is ready, exits 1 if it fails to start within 120s.

set -e

# ── 1. Symlink network volume models into ComfyUI ─────────────────────────────
# /workspace is the RunPod network volume mount (bc74lndvht).
# We symlink rather than copy so models are read live from the volume.
echo "[start_comfyui] Setting up model symlinks..."

mkdir -p /workspace/ComfyUI/models

# Remove any stale symlink or empty dir
if [ -L /ComfyUI/models ]; then
  rm /ComfyUI/models
elif [ -d /ComfyUI/models ] && [ -z "$(ls -A /ComfyUI/models)" ]; then
  rmdir /ComfyUI/models
fi

# Create the symlink
ln -sfn /workspace/ComfyUI/models /ComfyUI/models
echo "[start_comfyui] Symlinked /ComfyUI/models -> /workspace/ComfyUI/models"

# Verify key model files exist before starting
CKPT_DIR="/workspace/ComfyUI/models/checkpoints"
HIGH_NOISE="${CKPT_DIR}/wan2.2_i2v_high_noise_14B_fp16.safetensors"
LOW_NOISE="${CKPT_DIR}/wan2.2_i2v_low_noise_14B_fp16.safetensors"

if [ ! -f "$HIGH_NOISE" ]; then
  echo "[start_comfyui] WARNING: High-noise base model not found at ${HIGH_NOISE}"
  echo "[start_comfyui] Run: huggingface-cli download Wan-AI/Wan2.2-I2V-A14B wan2.2_i2v_high_noise_14B_fp16.safetensors --local-dir ${CKPT_DIR} --local-dir-use-symlinks False"
fi

if [ ! -f "$LOW_NOISE" ]; then
  echo "[start_comfyui] WARNING: Low-noise base model not found at ${LOW_NOISE}"
  echo "[start_comfyui] Run: huggingface-cli download Wan-AI/Wan2.2-I2V-A14B wan2.2_i2v_low_noise_14B_fp16.safetensors --local-dir ${CKPT_DIR} --local-dir-use-symlinks False"
fi

# ── 2. Start ComfyUI in background ───────────────────────────────────────────
echo "[start_comfyui] Starting ComfyUI on 127.0.0.1:8188..."
python /ComfyUI/main.py \
  --listen 127.0.0.1 \
  --port 8188 \
  --disable-auto-launch \
  --output-directory /tmp/comfyui_output \
  &

COMFYUI_PID=$!
echo "[start_comfyui] ComfyUI PID: ${COMFYUI_PID}"

# ── 3. Wait for ComfyUI to be ready ──────────────────────────────────────────
echo "[start_comfyui] Waiting for ComfyUI to respond on :8188..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8188/system_stats > /dev/null 2>&1; then
    echo "[start_comfyui] ComfyUI ready (after ${i}×2s = $((i*2))s)"
    exit 0
  fi
  
  # Check if process died
  if ! kill -0 $COMFYUI_PID 2>/dev/null; then
    echo "[start_comfyui] ComfyUI process died unexpectedly"
    exit 1
  fi
  
  sleep 2
done

echo "[start_comfyui] ComfyUI failed to start within 120s"
exit 1
