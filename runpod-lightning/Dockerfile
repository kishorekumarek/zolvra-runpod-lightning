# Dockerfile — RunPod Wan 2.2 Lightning I2V Serverless Handler
# No models baked in — all weights loaded from /workspace at runtime via network volume.
# Build: docker build --platform linux/amd64 -t zolvra/runpod-wan-lightning-i2v:v1.0.0 .
# Requires linux/amd64 — use --platform flag on Apple Silicon.

FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

# ── 1. System deps ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    git \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Python deps ────────────────────────────────────────────────────────────
# runpod SDK for serverless handler
RUN pip install --no-cache-dir runpod==1.7.3

# Core inference / media deps
RUN pip install --no-cache-dir \
    transformers==4.44.2 \
    accelerate==0.34.2 \
    safetensors==0.4.5 \
    einops==0.8.0 \
    imageio==2.36.0 \
    imageio-ffmpeg==0.5.1 \
    av==13.1.0 \
    Pillow==10.4.0 \
    requests==2.32.3

# ── 3. ComfyUI ────────────────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /ComfyUI
RUN pip install --no-cache-dir -r /ComfyUI/requirements.txt

# ── 4. WanVideoWrapper (Kijai) custom node ────────────────────────────────────
# PIN THIS COMMIT SHA — update after verifying against forKJ.json on volume.
# To record: cd /ComfyUI/custom_nodes/ComfyUI-WanVideoWrapper && git rev-parse HEAD
# WANVIDEOWRAPPER_SHA: __FILL_IN_AT_BUILD_TIME__
RUN git clone --depth 1 \
    https://github.com/kijai/ComfyUI-WanVideoWrapper \
    /ComfyUI/custom_nodes/ComfyUI-WanVideoWrapper

RUN pip install --no-cache-dir \
    -r /ComfyUI/custom_nodes/ComfyUI-WanVideoWrapper/requirements.txt \
    || true   # non-fatal: some optional deps may not install on base CUDA image

# VideoHelperSuite — required by WanVideoWrapper for VHS_VideoCombine node
RUN git clone --depth 1 \
    https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite \
    /ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite

RUN pip install --no-cache-dir \
    -r /ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt \
    || true

# ── 5. App files ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY start_comfyui.sh /app/start_comfyui.sh
COPY handler.py /app/handler.py
COPY lightning_i2v.json /app/workflows/lightning_i2v.json

RUN chmod +x /app/start_comfyui.sh

# Create output dir for ComfyUI
RUN mkdir -p /tmp/comfyui_output

# ── 6. NOTE: model symlink at /ComfyUI/models → /workspace/ComfyUI/models ─────
# This is done at RUNTIME in start_comfyui.sh (not here) because /workspace
# is not mounted during docker build — it's the RunPod network volume.

EXPOSE 8188

CMD ["python", "/app/handler.py"]
