// lib/image-gen.mjs — Google AI Imagen wrapper
import 'dotenv/config';
import { deflateSync } from 'zlib';
import { getSetting } from './settings.mjs';

const FALLBACK_MODEL = 'imagen-4.0-generate-001';

/**
 * Call the Imagen API for one model. Returns { buffer } on success, throws on error.
 * Throws an object with .is429 = true when quota is exceeded.
 */
async function callImagenAPI({ model, prompt, safetyLevel, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '16:9',
        safetyFilterLevel: safetyLevel,
        personGeneration: 'allow_all',
      },
    }),
  });

  const data = await response.json();

  if (response.status === 429) {
    const err = new Error(`Imagen quota exceeded (429) for model ${model}`);
    err.is429 = true;
    throw err;
  }

  if (!response.ok) {
    throw new Error(
      `Image gen failed (${response.status}): ${data?.error?.message || JSON.stringify(data)}`
    );
  }

  const predictions = data.predictions;
  if (!predictions || predictions.length === 0) {
    throw new Error('No predictions returned from Imagen API');
  }

  const base64 = predictions[0].bytesBase64Encoded;
  if (!base64) {
    throw new Error('No image data in Imagen response');
  }

  return Buffer.from(base64, 'base64');
}

/**
 * Create a solid-color 768x768 PNG placeholder (no external deps).
 * Used when all Imagen quota is exhausted.
 */
function createPlaceholderPng(sceneNumber) {
  const width = 768;
  const height = 768;

  // CRC32 implementation
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([typeBytes, data]);
    const crcVal = Buffer.alloc(4);
    crcVal.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeBytes, data, crcVal]);
  }

  // Muted blue-gray fill
  const [r, g, b] = [80, 100, 140];
  const rowSize = width * 3;
  const raw = Buffer.alloc(height * (rowSize + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowSize + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const off = y * (rowSize + 1) + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  // compression, filter, interlace all 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Generate a scene image via Google AI Imagen.
 * Falls back: primary model → imagegeneration@006 → solid-color placeholder.
 * Returns a Buffer of the PNG image.
 */
export async function generateSceneImage({ prompt, safetyLevel = 'block_few', sceneNumber = 0 }) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');

  let primaryModel;
  try {
    primaryModel = await getSetting('image_model');
  } catch {
    primaryModel = 'imagen-4.0-fast-generate-001';
  }

  // Attempt 1: primary model
  try {
    return await callImagenAPI({ model: primaryModel, prompt, safetyLevel, apiKey });
  } catch (err) {
    if (!err.is429) throw err;
    console.warn(`  ⚠️  ${primaryModel} quota exhausted, trying ${FALLBACK_MODEL}...`);
  }

  // Attempt 2: Imagen 3 fallback (separate quota)
  try {
    return await callImagenAPI({ model: FALLBACK_MODEL, prompt, safetyLevel, apiKey });
  } catch (err) {
    console.warn(`  ⚠️  ${FALLBACK_MODEL} failed (${err.message}), using placeholder for scene ${sceneNumber}`);
  }

  // Attempt 3: solid-color placeholder
  return createPlaceholderPng(sceneNumber);
}

/**
 * Build a full scene prompt from character base + scene description.
 * @param {object} scene
 * @param {object|null} character
 * @param {string} [extraSuffix] - additional safety/style modifiers appended last
 */
export function buildScenePrompt(scene, character = null, extraSuffix = '') {
  const baseCharacterPrompt = character?.image_prompt ?? '';
  const parts = [
    baseCharacterPrompt,
    scene.visual_description,
    "children's animated illustration style, soft watercolor, warm colors,",
    'no text, no watermark, safe for kids, 16:9 composition',
    'child-friendly illustration, G-rated, appropriate for all ages, no violence, no adult content, safe for children, cartoon style',
  ];
  if (extraSuffix) parts.push(extraSuffix);
  return parts.filter(Boolean).join('. ');
}

/**
 * Cost: $0.004 per image for fast model, $0.04 for quality
 */
export function estimateImageCost(model = 'imagen-4.0-fast-generate-001') {
  return model.includes('fast') ? 0.004 : 0.04;
}
