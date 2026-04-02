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

async function fetchConceptData(taskId) {
  const supabase = getSupabase();
  const { data: pipelineState } = await supabase
    .from('pipeline_state')
    .select('concept_id, youtube_seo_id')
    .eq('task_id', taskId)
    .single();

  if (!pipelineState) {
    throw new Error('Pipeline state not found');
  }

  const { data: concept } = await supabase
    .from('concepts')
    .select('title, synopsis, art_style, characters')
    .eq('id', pipelineState.concept_id)
    .single();

  const { data: youtubeSeo } = await supabase
    .from('youtube_seo')
    .select('title')
    .eq('id', pipelineState.youtube_seo_id)
    .single();

  const { data: episodeCharacters } = await supabase
    .from('episode_characters')
    .select('character_name, reference_image_url')
    .eq('status', 'approved')
    .eq('concept_id', pipelineState.concept_id);

  return {
    pipelineState,
    concept,
    youtubeSeo,
    episodeCharacters,
  };
}

async function downloadCharacterImages(episodeCharacters) {
  const supabase = getSupabase();
  const referenceImages = [];

  for (const character of episodeCharacters) {
    if (character.reference_image_url) {
      const { data, error } = await supabase.storage
        .from('character-images')
        .download(character.reference_image_url);

      if (error) {
        console.warn(`Error downloading image for ${character.character_name}: ${error.message}`);
        continue;
      }

      const buffer = await data.arrayBuffer();
      const base64String = Buffer.from(buffer).toString('base64');
      referenceImages.push({
        mimeType: 'image/png',
        data: base64String,
      });
    }
  }

  return referenceImages;
}

async function generateThumbnails(taskId, concept, youtubeSeo, referenceImages) {
  const title = youtubeSeo?.title || concept.title;
  const synopsis = concept.synopsis;
  const characters = concept.characters.map((char) => char.character_name).join(', ');

  const variants = [
    {
      id: 'a',
      prompt: `
        Cinematic YouTube thumbnail. 3D Pixar animation style. High contrast, vibrant colours.
        Story: ${synopsis}
        Characters: ${characters}
        Show the main characters in a dramatic, tense moment that captures the conflict of the story.
        Use the provided character reference images to match their appearance exactly.
        IMPORTANT LAYOUT:
        - Keep bottom 20% of image clear and uncluttered — this area will have title text overlaid
        - Keep top-left corner clear (120x80px from top-left) — channel logo goes here
        - Use rich warm lighting, expressive faces, dynamic composition
        - Thumbnail optimised: bold colours, strong focal point, emotion-driven
      `,
    },
    {
      id: 'b',
      prompt: `
        Cinematic YouTube thumbnail. 3D Pixar animation style. High contrast, vibrant colours.
        Story: ${synopsis}
        Characters: ${characters}
        Show an emotional or clever moment — a character's reaction, a surprising reveal, or a heartfelt scene.
        Use the provided character reference images to match their appearance exactly.
        IMPORTANT LAYOUT:
        - Keep bottom 20% of image clear and uncluttered — this area will have title text overlaid
        - Keep top-left corner clear (120x80px from top-left) — channel logo goes here
        - Warm golden tones, expressive wide eyes, sense of wonder or cleverness
        - Thumbnail optimised: bold colours, strong focal point, emotion-driven
      `,
    },
  ];

  for (const variant of variants) {
    const { imageData, mimeType } = await generateSceneImage({
      aspectRatio: '16:9',
      resolution: '1K',
      prompt: variant.prompt,
      referenceImages,
    });

    const outputPath = join(OUTPUT_BASE, taskId, `thumbnail_${variant.id}_raw.png`);
    writeFileSync(outputPath, Buffer.from(imageData, 'base64'));

    compositeThumbnail(taskId, variant.id, title, outputPath);
  }
}

function compositeThumbnail(taskId, variantId, title, rawImagePath) {
  const finalPath = join(OUTPUT_BASE, taskId, `thumbnail_${variantId}_final.png`);

  try {
    execSync(
      `${FFMPEG} -y -i ${rawImagePath} -i ${LOGO} -filter_complex "[1:v]scale=120:-1[logo];[0:v][logo]overlay=40:40[with_logo];[with_logo]drawtext=text='${title.replace(/'/g, "'")}' fontsize=64:fontcolor=yellow:borderw=4:bordercolor=black:x=40:y=h-text_h-40:font=bold" ${finalPath}`,
      { stdio: 'inherit' }
    );
  } catch (error) {
    console.warn(`FFmpeg failed for thumbnail ${variantId}: ${error.message}`);
  }

  console.log(`✅ Thumbnail ${variantId.toUpperCase()}: ${finalPath}`);
}

async function main(taskId) {
  try {
    const { pipelineState, concept, youtubeSeo, episodeCharacters } = await fetchConceptData(taskId);
    const referenceImages = await downloadCharacterImages(episodeCharacters);
    await generateThumbnails(taskId, concept, youtubeSeo, referenceImages);
  } catch (error) {
    console.error(`Error processing task ${taskId}: ${error.message}`);
  }
}

if (process.argv.length < 3) {
  console.error('Usage: node scripts/gen-thumbnail.mjs <task_id>');
  process.exit(1);
}

const taskId = process.argv[2];
main(taskId);
