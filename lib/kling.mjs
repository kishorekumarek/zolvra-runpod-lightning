// lib/kling.mjs — Hailuo API wrapper via kie.ai (image-to-video)
import 'dotenv/config';

const KIEAI_BASE = 'https://api.kie.ai';
const CREATE_ENDPOINT = '/api/v1/jobs/createTask';
const QUERY_ENDPOINT  = '/api/v1/jobs/recordInfo'; // ?taskId=

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Submit an image-to-video job to Hailuo via kie.ai.
 * Returns the taskId for polling.
 *
 *   POST /api/v1/jobs/createTask
 *   { model, input: { prompt, image_url, duration, resolution, prompt_optimizer } }
 */
export async function submitKlingJob({ imageUrl, prompt, motionParams }) {
  const apiKey = process.env.KIEAI_API_KEY;
  if (!apiKey) throw new Error('KIEAI_API_KEY not set');

  const fullPrompt = [
    prompt,
    motionParams?.prompt_suffix,
    'children animated style, smooth gentle motion, safe for kids',
  ].filter(Boolean).join('. ');

  const body = {
    model: 'hailuo/02-image-to-video-standard',
    input: {
      prompt:           fullPrompt,
      image_url:        imageUrl,
      duration:         '10',
      resolution:       '768P',
      prompt_optimizer: true,
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
      `Hailuo submit failed (${response.status}/${data?.code}): ${data?.msg || data?.message || JSON.stringify(data)}`
    );
  }

  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error(`Hailuo API returned no taskId: ${JSON.stringify(data)}`);

  console.log(`  🎬 Hailuo job submitted: ${taskId}`);
  return taskId;
}

/**
 * Poll a Hailuo job until completed or failed.
 * Returns the video URL on success.
 */
export async function pollKlingJob(taskId, maxWaitMs = 600000) {
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
      throw new Error(`Hailuo poll failed (${response.status}): ${JSON.stringify(data)}`);
    }

    const state    = data?.data?.state;
    const resultJson = data?.data?.resultJson;
    console.log(`  🎬 Hailuo ${taskId} (attempt ${attempts}): ${state}`);

    if (state === 'success') {
      let resultUrls;
      try { resultUrls = JSON.parse(resultJson)?.resultUrls; } catch {}
      const videoUrl = resultUrls?.[0];
      if (!videoUrl) throw new Error('Hailuo job succeeded but no video URL in resultJson');
      return videoUrl;
    }

    if (state === 'fail') {
      const failMsg = data?.data?.failMsg || 'Unknown error';
      throw new Error(`Hailuo job failed: ${failMsg} (code: ${data?.data?.failCode})`);
    }

    // Still processing — wait 10s and retry
    await sleep(10000);
  }

  throw new Error(`Hailuo job ${taskId} timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Download a video from a URL and return as Buffer.
 */
export async function downloadKlingVideo(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Hailuo video: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
