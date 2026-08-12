#!/usr/bin/env node
// publish-local.mjs — Upload a local video file directly to YouTube (private)
// Usage: node scripts/publish-local.mjs <task_id>
import 'dotenv/config';
import { createReadStream, statSync } from 'fs';
import { getSupabase } from '../lib/supabase.mjs';
import { getYouTubeClient } from '../lib/youtube.mjs';
import { sendTelegramMessage } from '../lib/telegram.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const taskId = process.argv[2];
if (!taskId) { console.error('Usage: node scripts/publish-local.mjs <task_id>'); process.exit(1); }

const sb = getSupabase();
const yt = await getYouTubeClient();

// Get SEO data
const { data: ps } = await sb.from('pipeline_state').select('youtube_seo_id').eq('task_id', taskId).single();
const { data: seo } = await sb.from('youtube_seo').select('title, description, tags').eq('id', ps.youtube_seo_id).single();

const videoPath = join(__dirname, `../output/${taskId}/final.mp4`);
const fileSize = statSync(videoPath).size;
console.log(`📤 Uploading: ${seo.title}`);
console.log(`   File: ${videoPath} (${(fileSize/1024/1024).toFixed(1)} MB)`);

const res = await yt.videos.insert({
  part: ['snippet', 'status'],
  requestBody: {
    snippet: {
      title: seo.title,
      description: seo.description,
      tags: seo.tags,
      categoryId: '27',
      defaultLanguage: 'ta',
      defaultAudioLanguage: 'ta',
    },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  },
  media: { body: createReadStream(videoPath) },
}, { onUploadProgress: (e) => process.stdout.write(`\r  Progress: ${(e.bytesRead/fileSize*100).toFixed(1)}%`) });

const videoId = res.data.id;
console.log(`\n✅ Uploaded: https://youtu.be/${videoId}`);

// Update video_queue if exists
await sb.from('video_queue').update({ status: 'uploaded', youtube_video_id: videoId, uploaded_at: new Date().toISOString() }).eq('task_id', taskId);

// Telegram notify
await sendTelegramMessage(`✅ *${seo.title}*\n\nUploaded (private): https://youtu.be/${videoId}\nMake public via YouTube Studio when ready 🚀`);
console.log('📱 Telegram notified');
