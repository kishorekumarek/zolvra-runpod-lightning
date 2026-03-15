// lib/image-gen.mjs — Google Gemini 3.1 Flash Image (Nano Banana 2) wrapper
import 'dotenv/config';
import { deflateSync } from 'zlib';

const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

/**
 * Call the Gemini 3.1 Flash Image API. Returns a Buffer on success, throws on error.
 * Throws an object with .is429 = true when quota is exceeded.
 */
async function callGeminiImageAPI({ prompt, aspectRatio = '16:9', resolution = '1K', apiKey, referenceImages = [] }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;

  // Build request parts: text prompt + optional reference image inlines (cap at 4)
  const cappedRefs = referenceImages.slice(0, 4);
  const requestParts = [
    { text: prompt },
    ...cappedRefs.map(buf => ({
      inlineData: {
        mimeType: 'image/png',
        data: buf.toString('base64'),
      },
    })),
  ];

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: requestParts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio,
          imageSize: resolution,
        },
      },
    }),
  });

  const data = await response.json();

  if (response.status === 429) {
    const err = new Error(`Gemini image quota exceeded (429) for model ${GEMINI_IMAGE_MODEL}`);
    err.is429 = true;
    throw err;
  }

  if (!response.ok) {
    throw new Error(
      `Image gen failed (${response.status}): ${data?.error?.message || JSON.stringify(data)}`
    );
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error('No content parts returned from Gemini Image API');
  }

  const imagePart = parts.find(p => p.inlineData);
  if (!imagePart) {
    // Log text parts for debugging
    const textParts = parts.filter(p => p.text).map(p => p.text).join(' ');
    throw new Error(`No image data in Gemini response. Text: ${textParts || '(none)'}`);
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

/**
 * Create a solid-color 1280x720 PNG placeholder (no external deps).
 * Used when Gemini image quota is exhausted.
 */
function createPlaceholderPng(sceneNumber) {
  const width = 1280;
  const height = 720;

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
 * Generate a scene image via Gemini 3.1 Flash Image (Nano Banana 2).
 * Falls back to solid-color placeholder if Gemini fails or quota exhausted.
 * Returns a Buffer of the PNG image.
 */
export async function generateSceneImage({ prompt, sceneNumber = 0, aspectRatio = '16:9', resolution = '1K', referenceImages = [] }) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');

  // Attempt: Gemini 3.1 Flash Image
  try {
    return await callGeminiImageAPI({ prompt, aspectRatio, resolution, apiKey, referenceImages });
  } catch (err) {
    if (err.is429) {
      console.warn(`  ⚠️  Gemini image quota exhausted (429), using placeholder for scene ${sceneNumber}`);
    } else {
      console.warn(`  ⚠️  Gemini image gen failed (${err.message}), using placeholder for scene ${sceneNumber}`);
    }
  }

  // Fallback: solid-color placeholder
  return createPlaceholderPng(sceneNumber);
}

/**
 * Build a full scene prompt from character base + scene description.
 * Starts with Pixar-style 3D cartoon prefix for safety filter avoidance.
 * @param {object} scene
 * @param {object|null} character
 * @param {string} [extraSuffix] - additional safety/style modifiers appended last
 */
export function buildScenePrompt(scene, character = null, extraSuffix = '') {
  const baseCharacterPrompt = character?.image_prompt ?? '';
  const parts = [
    '3D cartoon animation still, Pixar-style, child-friendly,',
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
 * Cost: ~$0.004 per image for Gemini 3.1 Flash Image
 */
export function estimateImageCost(_model = GEMINI_IMAGE_MODEL) {
  return 0.004;
}
