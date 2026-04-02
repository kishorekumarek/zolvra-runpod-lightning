// File: streams/youtube/scripts/gen-thumbnail.mjs
import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getSupabase } from '../lib/supabase.mjs';
import { generateSceneImage } from '../lib/image-gen.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const LOGO = join(__dirname, '../assets/channel-logo.png');
const OUTPUT_BASE = join(__dirname, '../output');
const ARIAL_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchConceptData(taskId) {
  const supabase = getSupabase();

  const { data: pipelineState, error: psError } = await supabase
    .from('pipeline_state')
    .select('concept_id, youtube_seo_id')
    .eq('task_id', taskId)
    .single();

  if (psError || !pipelineState) {
    throw new Error(`Pipeline state not found for task ${taskId}: ${psError?.message}`);
  }

  const { data: concept, error: conceptError } = await supabase
    .from('concepts')
    .select('title, synopsis, art_style, characters')
    .eq('id', pipelineState.concept_id)
    .single();

  if (conceptError || !concept) {
    throw new Error(`Concept not found (id=${pipelineState.concept_id}): ${conceptError?.message}`);
  }

  // youtube_seo is optional — fall back to concept title if missing
  const { data: youtubeSeo } = await supabase
    .from('youtube_seo')
    .select('title')
    .eq('id', pipelineState.youtube_seo_id)
    .single();

  // FIX: episode_characters is keyed by task_id, not concept_id
  const { data: episodeCharacters } = await supabase
    .from('episode_characters')
    .select('character_name, reference_image_url')
    .eq('task_id', taskId)
    .eq('status', 'approved');

  return {
    pipelineState,
    concept,
    youtubeSeo,
    episodeCharacters: episodeCharacters || [],
  };
}

// ── Character image downloads ─────────────────────────────────────────────────

/**
 * Downloads approved character reference images from Supabase Storage.
 * Returns an array of Buffers — the format expected by callGeminiImageAPI
 * (which calls buf.toString('base64') on each entry).
 */
async function downloadCharacterImages(episodeCharacters) {
  const supabase = getSupabase();
  const referenceImages = []; // array of Buffer

  for (const character of episodeCharacters) {
    if (!character.reference_image_url) continue;

    const { data, error } = await supabase.storage
      .from('character-images')
      .download(character.reference_image_url);

    if (error || !data) {
      console.warn(`⚠️  Could not download image for ${character.character_name}: ${error?.message}`);
      continue;
    }

    // data is a Blob — convert to Buffer
    const arrayBuffer = await data.arrayBuffer();
    referenceImages.push(Buffer.from(arrayBuffer));
  }

  return referenceImages;
}

// ── ffmpeg helpers ────────────────────────────────────────────────────────────

/**
 * Escape text for safe injection into an ffmpeg drawtext filter value.
 * The text sits inside single quotes within a double-quoted shell string, e.g.:
 *   ffmpeg ... -filter_complex "...drawtext=text='<HERE>':..."
 *
 * Rules:
 *   \  → \\          (backslash must come first)
 *   '  → '\''        (end quote, shell-escaped apostrophe, reopen quote)
 *   :  → \:          (colon is ffmpeg filter separator)
 */
function escapeFfmpegText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:');
}

/**
 * Build the drawtext filter fragment(s).
 * Splits into two stacked lines if title is longer than 30 characters.
 */
function buildDrawtextFilter(title) {
  const fontfileClause = existsSync(ARIAL_BOLD)
    ? `fontfile='${ARIAL_BOLD}':`
    : '';
  const baseStyle = `fontsize=64:fontcolor=yellow:borderw=4:bordercolor=black:x=40`;

  if (title.length <= 30) {
    const escaped = escapeFfmpegText(title);
    return `drawtext=text='${escaped}':${fontfileClause}${baseStyle}:y=h-text_h-40`;
  }

  // Split at a word boundary near the midpoint
  const mid = Math.floor(title.length / 2);
  let splitIdx = title.lastIndexOf(' ', mid);
  if (splitIdx === -1) splitIdx = title.indexOf(' ', mid);
  if (splitIdx === -1) splitIdx = mid; // no spaces — hard split

  const line1 = escapeFfmpegText(title.slice(0, splitIdx).trim());
  const line2 = escapeFfmpegText(title.slice(splitIdx).trim());

  return [
    `drawtext=text='${line1}':${fontfileClause}${baseStyle}:y=h-text_h-110`,
    `drawtext=text='${line2}':${fontfileClause}${baseStyle}:y=h-text_h-40`,
  ].join(',');
}

// ── Thumbnail generation ──────────────────────────────────────────────────────

async function generateThumbnails(taskId, concept, youtubeSeo, referenceImages) {
  const title = youtubeSeo?.title || concept.title;
  const synopsis = concept.synopsis || '';
  const characters = (concept.characters || [])
    .map(c => c.character_name || c.name || String(c))
    .filter(Boolean)
    .join(', ');

  const outputDir = join(OUTPUT_BASE, taskId);
  mkdirSync(outputDir, { recursive: true });

  const variants = [
    {
      id: 'a',
      prompt: `Cinematic YouTube thumbnail. 3D Pixar animation style. High contrast, vibrant colours.
Story: ${synopsis}
Characters: ${characters}
Show the main characters in a dramatic, tense moment that captures the conflict of the story.
Use the provided character reference images to match their appearance exactly.
IMPORTANT LAYOUT:
- Keep bottom 20% of image clear and uncluttered — this area will have title text overlaid
- Keep top-left corner clear (120x80px from top-left) — channel logo goes here
- Use rich warm lighting, expressive faces, dynamic composition
- Thumbnail optimised: bold colours, strong focal point, emotion-driven`,
    },
    {
      id: 'b',
      prompt: `Cinematic YouTube thumbnail. 3D Pixar animation style. High contrast, vibrant colours.
Story: ${synopsis}
Characters: ${characters}
Show an emotional or clever moment — a character's reaction, a surprising reveal, or a heartfelt scene.
Use the provided character reference images to match their appearance exactly.
IMPORTANT LAYOUT:
- Keep bottom 20% of image clear and uncluttered — this area will have title text overlaid
- Keep top-left corner clear (120x80px from top-left) — channel logo goes here
- Warm golden tones, expressive wide eyes, sense of wonder or cleverness
- Thumbnail optimised: bold colours, strong focal point, emotion-driven`,
    },
  ];

  for (const variant of variants) {
    console.log(`🎨 Generating thumbnail ${variant.id.toUpperCase()}...`);

    // FIX: generateSceneImage returns a Buffer directly — not { imageData, mimeType }
    const imageBuffer = await generateSceneImage({
      aspectRatio: '16:9',
      resolution: '1K',
      prompt: variant.prompt,
      referenceImages, // array of Buffers — callGeminiImageAPI calls .toString('base64') on each
    });

    const rawPath = join(outputDir, `thumbnail_${variant.id}_raw.png`);
    writeFileSync(rawPath, imageBuffer);

    compositeThumbnail(taskId, variant.id, title, rawPath);
  }
}

function compositeThumbnail(taskId, variantId, title, rawImagePath) {
  const outputDir = join(OUTPUT_BASE, taskId);
  const finalPath = join(outputDir, `thumbnail_${variantId}_final.png`);
  const drawtextFilter = buildDrawtextFilter(title);

  // FIX: each segment in filter_complex is separated by semicolons;
  //      drawtext params use colons — was missing colon after text='...'
  const filterComplex = [
    '[1:v]scale=120:-1[logo]',
    '[0:v][logo]overlay=40:40[with_logo]',
    `[with_logo]${drawtextFilter}`,
  ].join(';');

  // FIX: quote paths to handle spaces; use proper filter_complex string
  const cmd = `"${FFMPEG}" -y -i "${rawImagePath}" -i "${LOGO}" -filter_complex "${filterComplex}" "${finalPath}"`;

  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✅ Thumbnail ${variantId.toUpperCase()}: ${finalPath}`);
  } catch (error) {
    console.warn(`⚠️  FFmpeg failed for thumbnail ${variantId}: ${error.message}`);
    console.log(`✅ Thumbnail ${variantId.toUpperCase()} (raw only): ${rawImagePath}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.length < 3) {
    console.error('Usage: node scripts/gen-thumbnail.mjs <task_id>');
    process.exit(1);
  }

  const taskId = process.argv[2];
  console.log(`🖼️  Generating thumbnails for task: ${taskId}`);

  try {
    const { concept, youtubeSeo, episodeCharacters } = await fetchConceptData(taskId);

    if (episodeCharacters.length === 0) {
      console.warn('⚠️  No approved character reference images found — generating without references');
    }

    const referenceImages = await downloadCharacterImages(episodeCharacters);
    await generateThumbnails(taskId, concept, youtubeSeo, referenceImages);
  } catch (error) {
    console.error(`❌ Error processing task ${taskId}: ${error.message}`);
    process.exit(1);
  }
}

main();
