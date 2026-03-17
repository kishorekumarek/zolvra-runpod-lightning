#!/usr/bin/env node
// scripts/upload-ep02-minmini.mjs — Upload EP02 "Minmini" to YouTube as unlisted

import 'dotenv/config';
import { uploadVideoUnlisted } from '../lib/youtube.mjs';

const videoPath = '/Users/friday/.openclaw/workspace/streams/youtube/output/ep02-assembly-final/ep02-minmini-FINAL-synced.mp4';
const taskId = '210cfd98-f7d1-4f06-ac1d-e0f2587441d4';

const script = {
  youtube_seo: {
    title: 'மின்மினி — Minmini (Fireflies) 🌟 | Tamil Kids Story | Tiny Tamil Tales',
    description: `Kaavya, Arjun, Meenu — moonu friends kaatula minmini poochigala paakuraanga! Bottle-la pudichchu vachcha, velicham koraiyuthu... Enna pannuvaanga?

A heartwarming Tamil story about fireflies, freedom, and friendship for little ones.

"Yarayum koondula adachi vekka-vey kudaathu" — You can't trap something wild. True beauty is in freedom.

Subscribe to Tiny Tamil Tales for more Tamil kids stories! 🦚✨

#TamilKidsStory #TinyTamilTales #TamilCartoon #Minmini #FirefliesStory #TamilBedtimeStory #KidsStoryTamil #TamilAnimation`,
    tags: [
      'tamil kids story',
      'tamil cartoon',
      'tiny tamil tales',
      'minmini',
      'fireflies story tamil',
      'tamil bedtime story',
      'tamil moral story',
      'kids story tamil',
      'tamil animation',
      'friendship story tamil',
      'மின்மினி',
      'தமிழ் கதை',
      'குழந்தைகளுக்கான கதை'
    ],
  },
};

console.log('🚀 Uploading EP02 "Minmini" to YouTube (unlisted)...\n');
console.log(`  File: ${videoPath}`);
console.log(`  Title: ${script.youtube_seo.title}\n`);

try {
  const videoId = await uploadVideoUnlisted({ videoPath, script, taskId });
  const url = `https://youtu.be/${videoId}`;
  console.log(`\n✅ UPLOADED SUCCESSFULLY`);
  console.log(`  URL: ${url}`);
  console.log(`  Status: UNLISTED (awaiting Darl review)`);

  // Send to Telegram
  console.log(`\n📱 Sending link to Telegram...`);
  const telegramToken = '8760416831:AAHNmodjxV1vtRvQscNCieKvZS0q--oijBQ';
  const chatId = 7879469053;
  
  const telegramMsg = `🎬 EP02 "Minmini" (Fireflies) uploaded!

📺 ${url}

Status: UNLISTED — ready for your review.
Duration: ~51s
Scenes: 8 + end card
Voice: ElevenLabs v3 (Arjun, Kaavya, Meenu)
BGM: ✅ Light kids folk
Logo: ✅ Top right

Review and let me know if any changes needed!`;

  const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: telegramMsg }),
  });
  
  const result = await res.json();
  if (result.ok) {
    console.log('  ✅ Telegram notification sent');
  } else {
    console.error('  ❌ Telegram failed:', result.description);
  }

} catch (err) {
  console.error('❌ Upload failed:', err.message);
  process.exit(1);
}
