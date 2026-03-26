// lib/wan.mjs — Wan 2.6 image-to-video wrapper via kie.ai
import 'dotenv/config';

const KIEAI_BASE = 'https://api.kie.ai';
const CREATE_ENDPOINT = '/api/v1/jobs/createTask';
const QUERY_ENDPOINT  = '/api/v1/jobs/recordInfo'; // ?taskId=

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Submit an image-to-video job to Wan 2.6 via kie.ai.
 * Returns the taskId for polling.
 *
 *   POST /api/v1/jobs/createTask
 *   { model: "wan/2-6-image-to-video", input: { prompt, image_urls, duration, resolution, multi_shots } }
 */
export async function submitWanJob({ imageUrl, prompt, aspectRatio = '16:9', duration }) {
  const apiKey = process.env.KIEAI_API_KEY;
  if (!apiKey) throw new Error('KIEAI_API_KEY not set');

  // Append aspect-ratio orientation hint before sending to Wan
  const orientationHint = aspectRatio === '9:16'
    ? ' 9:16 vertical portrait orientation.'
    : ' 16:9 horizontal widescreen orientation.';
  const finalPrompt = (prompt + orientationHint).slice(0, 300);

  const clipDuration = duration ?? '10';

  const body = {
    model: 'wan/2-6-image-to-video',
    input: {
      prompt: finalPrompt,
      image_urls:  [imageUrl],
      duration:    clipDuration,
      resolution:  aspectRatio === '9:16' ? '720p' : '1080p',
      multi_shots: false,
    },
  };

  const response = await fetch(`${KIEAI_BASE}${CREATE_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (data?.code !== 200) {
    throw new Error(
      `Wan submit failed (${response.status}/${data?.code}): ${data?.msg || data?.message || JSON.stringify(data)}`
    );
  }

  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error(`Wan API returned no taskId: ${JSON.stringify(data)}`);

  console.log(`  🎬 Wan 2.6 job submitted: ${taskId}`);
  return taskId;
}

/**
 * Poll a Wan 2.6 job until completed or failed.
 * Returns the video URL on success.
 */
export async function pollWanJob(taskId, maxWaitMs = 600000) {
  const apiKey = process.env.KIEAI_API_KEY;
  if (!apiKey) throw new Error('KIEAI_API_KEY not set');

  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < maxWaitMs) {
    attempts++;

    const response = await fetch(`${KIEAI_BASE}${QUERY_ENDPOINT}?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Wan poll failed (${response.status}): ${JSON.stringify(data)}`);
    }

    const state      = data?.data?.state;
    const resultJson = data?.data?.resultJson;
    console.log(`  🎬 Wan ${taskId} (attempt ${attempts}): ${state}`);

    if (state === 'success') {
      let resultUrls;
      try { resultUrls = JSON.parse(resultJson)?.resultUrls; } catch {}
      const videoUrl = resultUrls?.[0];
      if (!videoUrl) throw new Error('Wan job succeeded but no video URL in resultJson');
      return videoUrl;
    }

    if (state === 'fail') {
      const failMsg = data?.data?.failMsg || 'Unknown error';
      throw new Error(`Wan job failed: ${failMsg} (code: ${data?.data?.failCode})`);
    }

    // Still processing — wait 15s and retry
    await sleep(15000);
  }

  throw new Error(`Wan job ${taskId} timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Download a video from a URL and return as Buffer.
 */
export async function downloadWanVideo(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Wan video: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
