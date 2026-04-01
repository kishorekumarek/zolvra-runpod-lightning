#!/usr/bin/env python3
"""
handler.py — RunPod serverless handler for Wan 2.2 Lightning I2V endpoint.

Two-stage Lightning LoRA workflow via ComfyUI API (WanVideoWrapper/Kijai nodes).
Hard-coded inference params: steps=4 total (2 per stage), cfg=1.0, sampler=lcm,
lora_strength=1.0, fps=16, format=video/h264-mp4.

Input:
  {
    "image_base64": "<raw base64, no data URI prefix>",
    "prompt": "<motion description, max 300 chars>",
    "negative_prompt": "<optional>",
    "width": 512,       # 512 or 992
    "height": 992,      # 992 or 512
    "length": 81,       # 81=~5s, 161=~10s. Default: 81
    "seed": -1          # -1 = random. Default: -1
  }

Output (success):  { "video": "<raw base64 mp4>" }
Output (failure):  { "error": "<message>" }
"""

import os
import sys
import json
import copy
import base64
import random
import subprocess
import tempfile
import time
import traceback
from pathlib import Path

import requests
import runpod

# ── Constants ─────────────────────────────────────────────────────────────────
COMFYUI_URL = "http://127.0.0.1:8188"
WORKFLOW_PATH = "/app/workflows/lightning_i2v.json"
OUTPUT_DIR = "/tmp/comfyui_output"
START_SCRIPT = "/app/start_comfyui.sh"

DEFAULT_NEGATIVE_PROMPT = (
    "nsfw, violence, blood, scary, dark, horror, blurry, low quality, "
    "distorted, ugly, deformed, watermark, text, logo"
)

HIGH_NOISE_LORA = (
    "wan2.2-i2v-lightning/"
    "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/"
    "high_noise_model.safetensors"
)
LOW_NOISE_LORA = (
    "wan2.2-i2v-lightning/"
    "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/"
    "low_noise_model.safetensors"
)

POLL_INTERVAL_S = 2
MAX_POLL_S = 120

# ── Cold-start: start ComfyUI ─────────────────────────────────────────────────
_comfyui_ready = False


def start_comfyui():
    """Run start_comfyui.sh and wait for ComfyUI to be ready."""
    global _comfyui_ready
    if _comfyui_ready:
        return

    print("[handler] Starting ComfyUI via start_comfyui.sh...")
    result = subprocess.run(
        ["/bin/bash", START_SCRIPT],
        capture_output=False,
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(f"start_comfyui.sh exited with code {result.returncode}")

    # Final health check
    _assert_comfyui_healthy(retries=5)
    _comfyui_ready = True
    print("[handler] ComfyUI is ready. Handler accepting jobs.")


def _assert_comfyui_healthy(retries: int = 3):
    """Raise if ComfyUI /system_stats doesn't respond."""
    for i in range(retries):
        try:
            r = requests.get(f"{COMFYUI_URL}/system_stats", timeout=5)
            if r.status_code == 200:
                return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("ComfyUI /system_stats not responding after retries")


def _attempt_comfyui_restart():
    """Try to restart ComfyUI after a mid-session crash."""
    global _comfyui_ready
    print("[handler] ComfyUI appears to have crashed — attempting restart...")
    _comfyui_ready = False
    try:
        start_comfyui()
        return True
    except Exception as e:
        print(f"[handler] ComfyUI restart failed: {e}")
        return False


# ── Load workflow template ────────────────────────────────────────────────────
_workflow_template: dict | None = None


def load_workflow_template() -> dict:
    global _workflow_template
    if _workflow_template is None:
        with open(WORKFLOW_PATH, "r") as f:
            _workflow_template = json.load(f)
        print(f"[handler] Loaded workflow template from {WORKFLOW_PATH}")
    return _workflow_template


# ── Parameter substitution ────────────────────────────────────────────────────
def _substitute(obj, replacements: dict):
    """
    Recursively walk obj (dict or list) and replace {{TOKEN}} strings.
    Handles string values, int/float values (token must be the whole string).
    """
    if isinstance(obj, dict):
        return {k: _substitute(v, replacements) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_substitute(item, replacements) for item in obj]
    elif isinstance(obj, str):
        for token, value in replacements.items():
            if obj == token:
                # Exact token match — allow type coercion (e.g. int width)
                return value
            elif token in obj:
                # Partial substitution — keep as string
                obj = obj.replace(token, str(value))
        return obj
    return obj


def build_workflow(job_id: str, job_input: dict, image_path: str) -> dict:
    """Clone the workflow template and substitute job parameters."""
    template = load_workflow_template()
    workflow = copy.deepcopy(template)

    seed = job_input.get("seed", -1)
    if seed == -1 or seed is None:
        seed = random.randint(0, 2**32 - 1)

    replacements = {
        "{{IMAGE_PATH}}": image_path,
        "{{PROMPT}}": job_input["prompt"][:300],
        "{{NEGATIVE_PROMPT}}": job_input.get("negative_prompt", DEFAULT_NEGATIVE_PROMPT),
        "{{WIDTH}}": int(job_input["width"]),
        "{{HEIGHT}}": int(job_input["height"]),
        "{{LENGTH}}": int(job_input.get("length", 81)),
        "{{SEED}}": seed,
        "{{OUTPUT_PREFIX}}": f"lightning_{job_id}",
        "{{HIGH_NOISE_LORA}}": HIGH_NOISE_LORA,
        "{{LOW_NOISE_LORA}}": LOW_NOISE_LORA,
    }

    return _substitute(workflow, replacements)


# ── ComfyUI job submission and polling ────────────────────────────────────────
def submit_to_comfyui(workflow: dict) -> str:
    """POST workflow to /prompt, return prompt_id."""
    payload = {"prompt": workflow}
    r = requests.post(f"{COMFYUI_URL}/prompt", json=payload, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(
            f"ComfyUI /prompt returned {r.status_code}: {r.text[:500]}"
        )
    data = r.json()
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"No prompt_id in ComfyUI response: {data}")
    return prompt_id


def poll_comfyui(prompt_id: str) -> dict:
    """
    Poll /history/<prompt_id> until the job completes or times out.
    Returns the history entry on success.
    """
    deadline = time.time() + MAX_POLL_S
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        try:
            r = requests.get(
                f"{COMFYUI_URL}/history/{prompt_id}", timeout=10
            )
        except Exception as e:
            print(f"[handler] Poll request error (retrying): {e}")
            continue

        if r.status_code != 200:
            print(f"[handler] /history returned {r.status_code}, retrying...")
            continue

        history = r.json()
        if prompt_id not in history:
            # Not done yet
            continue

        entry = history[prompt_id]
        status = entry.get("status", {})
        status_str = status.get("status_str", "")
        completed = status.get("completed", False)

        if completed or status_str == "success":
            return entry
        elif status_str in ("error", "failed"):
            msgs = status.get("messages", [])
            raise RuntimeError(f"ComfyUI job failed: {msgs}")
        # else: still running

    raise TimeoutError(f"ComfyUI job {prompt_id} timed out after {MAX_POLL_S}s")


def extract_video_path(history_entry: dict, job_id: str) -> str:
    """
    Extract the output video path from a ComfyUI history entry.
    Looks for VHS_VideoCombine node output (.mp4 file).
    Falls back to scanning OUTPUT_DIR for the most recent mp4.
    """
    outputs = history_entry.get("outputs", {})
    for node_id, node_output in outputs.items():
        gifs = node_output.get("gifs", [])
        for gif_entry in gifs:
            filename = gif_entry.get("filename", "")
            subfolder = gif_entry.get("subfolder", "")
            if filename.endswith(".mp4"):
                if subfolder:
                    return os.path.join(OUTPUT_DIR, subfolder, filename)
                return os.path.join(OUTPUT_DIR, filename)

    # Fallback: find the most recent mp4 matching our prefix
    prefix = f"lightning_{job_id}"
    candidates = sorted(
        Path(OUTPUT_DIR).glob(f"{prefix}*.mp4"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if candidates:
        return str(candidates[0])

    raise FileNotFoundError(
        f"No output mp4 found for job {job_id} in {OUTPUT_DIR}. "
        f"Outputs: {list(outputs.keys())}"
    )


# ── Main handler ──────────────────────────────────────────────────────────────
def handler(job: dict) -> dict:
    """RunPod serverless entry point. Called once per job."""
    job_id = job.get("id", f"local_{int(time.time())}")
    job_input = job.get("input", {})

    print(f"[handler] Job {job_id} received. Input keys: {list(job_input.keys())}")

    # ── Validate required fields ──────────────────────────────────────────────
    for required in ("image_base64", "prompt", "width", "height"):
        if required not in job_input:
            return {"error": f"Missing required field: {required}"}

    # ── Ensure ComfyUI is healthy ─────────────────────────────────────────────
    try:
        _assert_comfyui_healthy()
    except RuntimeError:
        print("[handler] ComfyUI health check failed — attempting restart...")
        if not _attempt_comfyui_restart():
            return {"error": "ComfyUI unavailable and restart failed"}

    # ── Decode and save input image ───────────────────────────────────────────
    image_path = f"/tmp/input_{job_id}.png"
    try:
        image_bytes = base64.b64decode(job_input["image_base64"])
        with open(image_path, "wb") as f:
            f.write(image_bytes)
        print(f"[handler] Saved input image: {image_path} ({len(image_bytes)} bytes)")
    except Exception as e:
        return {"error": f"Failed to decode image_base64: {e}"}

    video_path = None
    try:
        # ── Build workflow ────────────────────────────────────────────────────
        workflow = build_workflow(job_id, job_input, image_path)

        # ── Submit to ComfyUI ─────────────────────────────────────────────────
        print(f"[handler] Submitting workflow to ComfyUI...")
        t0 = time.time()
        prompt_id = submit_to_comfyui(workflow)
        print(f"[handler] prompt_id: {prompt_id}")

        # ── Poll until complete ───────────────────────────────────────────────
        history_entry = poll_comfyui(prompt_id)
        elapsed = time.time() - t0
        print(f"[handler] Job {job_id} completed in {elapsed:.1f}s")

        # ── Read output video ─────────────────────────────────────────────────
        video_path = extract_video_path(history_entry, job_id)
        print(f"[handler] Output video: {video_path}")

        with open(video_path, "rb") as f:
            video_bytes = f.read()

        video_base64 = base64.b64encode(video_bytes).decode("utf-8")
        print(
            f"[handler] Encoded video: {len(video_bytes)} bytes → "
            f"{len(video_base64)} base64 chars"
        )

        return {"video": video_base64}

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[handler] ERROR for job {job_id}:\n{tb}")
        return {"error": str(e)}

    finally:
        # Clean up temp files
        for path in [image_path, video_path]:
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass


# ── Entrypoint ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("[handler] Cold start: initialising ComfyUI...")
    try:
        start_comfyui()
        load_workflow_template()
    except Exception as e:
        print(f"[handler] FATAL: Cold start failed: {e}")
        traceback.print_exc()
        sys.exit(1)

    print("[handler] Registering RunPod handler...")
    runpod.serverless.start({"handler": handler})
