#!/bin/bash
# build.sh — Build and push the RunPod Wan 2.2 Lightning I2V Docker image.
# Run from this directory: ./build.sh [version]
# Requires: docker, linux/amd64 platform (or BuildKit on Apple Silicon)
# Requires: docker login zolvra (or ghcr.io auth via: gh auth token | docker login ghcr.io -u <user> --password-stdin)

set -euo pipefail

REGISTRY="${REGISTRY:-docker.io}"
IMAGE_NAME="zolvra/runpod-wan-lightning-i2v"
VERSION="${1:-v1.0.0}"
FULL_TAG="${REGISTRY}/${IMAGE_NAME}:${VERSION}"
LATEST_TAG="${REGISTRY}/${IMAGE_NAME}:latest"

echo "▶ Building ${FULL_TAG}"
echo "  Platform: linux/amd64"
echo "  Context: $(pwd)"
echo ""

# ── Pre-build checks ──────────────────────────────────────────────────────────
if [ ! -f "Dockerfile" ]; then
  echo "❌ Dockerfile not found. Run from the runpod-lightning/ directory."
  exit 1
fi

if [ ! -f "lightning_i2v.json" ]; then
  echo "❌ lightning_i2v.json not found."
  echo "   If this file hasn't been updated from forKJ.json yet, follow these steps:"
  echo "   1. Spin up a RunPod pod with volume bc74lndvht attached"
  echo "   2. SCP the file:"
  echo "      scp -P <port> root@<ip>:/workspace/ComfyUI/models/loras/wan2.2-i2v-lightning/Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-forKJ.json lightning_i2v.json"
  echo "   3. Apply {{PLACEHOLDER}} tokens as defined in lightning_i2v.json"
  exit 1
fi

# ── Record WanVideoWrapper commit SHA ─────────────────────────────────────────
# The SHA is baked into the Dockerfile during build for reproducibility.
# To update: edit the git clone line in Dockerfile to git checkout <SHA>.
echo "  Note: WanVideoWrapper SHA is pinned in Dockerfile (see comment __FILL_IN_AT_BUILD_TIME__)."
echo "  To pin: after first build, exec into the image and run:"
echo "    docker run --rm ${FULL_TAG} bash -c 'cd /ComfyUI/custom_nodes/ComfyUI-WanVideoWrapper && git rev-parse HEAD'"
echo "  Then update the Dockerfile git clone line to git checkout <SHA>."
echo ""

# ── Docker build ──────────────────────────────────────────────────────────────
docker build \
  --platform linux/amd64 \
  -t "${FULL_TAG}" \
  -t "${LATEST_TAG}" \
  .

echo ""
echo "✅ Build complete: ${FULL_TAG}"
echo ""

# ── Docker push ───────────────────────────────────────────────────────────────
echo "▶ Pushing ${FULL_TAG}..."

# Attempt push — will fail if not logged in
if docker push "${FULL_TAG}" && docker push "${LATEST_TAG}"; then
  echo "✅ Pushed: ${FULL_TAG}"
  echo "✅ Pushed: ${LATEST_TAG}"
  echo ""
  echo "Next step: Create the RunPod endpoint via GraphQL:"
  echo "  See README.md § Create Endpoint"
else
  echo ""
  echo "⚠️  Push failed. Ensure you are logged in:"
  echo "   Docker Hub: docker login (zolvra account)"
  echo "   GHCR fallback: gh auth token | docker login ghcr.io -u kishorekumarek --password-stdin"
  echo "   Then set: REGISTRY=ghcr.io ./build.sh ${VERSION}"
  exit 1
fi
