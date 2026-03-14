// lib/image-gen.mjs — Google AI Imagen wrapper
import 'dotenv/config';
import { getSetting } from './settings.mjs';

/**
 * Generate a scene image via Google AI Imagen.
 * Returns a Buffer of the PNG image.
 */
export async function generateSceneImage({ prompt, safetyLevel = 'block_few' }) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');

  // Get model from settings, default to fast model
  let model;
  try {
    model = await getSetting('image_model');
  } catch {
    model = 'imagen-4.0-fast-generate-001';
  }

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
        personGeneration: 'allow_all', // animated characters, not real people
      },
    }),
  });

  const data = await response.json();

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
