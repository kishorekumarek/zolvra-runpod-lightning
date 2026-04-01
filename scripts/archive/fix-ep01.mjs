#!/usr/bin/env node
// scripts/fix-ep01.mjs — EP01 4-fix patch: subscribe clip, final video, thumbnail, upload package
import 'dotenv/config';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase } from '../lib/supabase.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FFMPEG  = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const OUTPUT_DIR  = join(__dirname, '..', 'output');
const ASSETS_DIR  = join(__dirname, '..', 'assets');
const MEMORY_DIR  = '/Users/friday/.openclaw/workspace/memory';
const SCENE03_IMG = join(MEMORY_DIR, 'scene_03_img.png');
const LOGO_PATH   = join(ASSETS_DIR, 'channel-logo.png');

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const KIEAI_KEY  = process.env.KIEAI_API_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────
// FIX 1 — Subscribe animation clip
// ─────────────────────────────────────────────────────────────────
async function fix1() {
  console.log('\n━━━ FIX 1: Subscribe Animation Clip ━━━\n');

  // 1a. ElevenLabs TTS
  const ttsPath = join(OUTPUT_DIR, 'subscribe-voice.mp3');
  console.log('🎤 Calling ElevenLabs TTS...');
  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/oDV9OTaNLmINQYHfVOXe?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "Enna story paatheengalaaaaa? Nalla irunthucha? Appo like pannunga, share pannunga — Tiny Tamil Tales-a subscribe pannunga!",
        model_id: 'eleven_v3',
        voice_settings: {},
      }),
    }
  );
  if (!ttsRes.ok) {
    const err = await ttsRes.text();
    throw new Error(`ElevenLabs failed (${ttsRes.status}): ${err}`);
  }
  const ttsBuf = Buffer.from(await ttsRes.arrayBuffer());
  await fs.writeFile(ttsPath, ttsBuf);
  console.log(`  ✓ TTS saved: ${ttsPath} (${(ttsBuf.length / 1024).toFixed(0)} KB)`);

  // 1b. Hailuo image-to-video
  const rawClipPath = join(OUTPUT_DIR, 'subscribe-clip-raw.mp4');
  console.log('\n🎬 Submitting Hailuo job via kie.ai...');

  // Upload image to Supabase storage to get a public URL (kie.ai rejects base64)
  const imgBuf = await fs.readFile(SCENE03_IMG);
  const sb = getSupabase();
  const storagePath = `subscribe-endcard/scene_03_img_${Date.now()}.png`;
  const { error: uploadErr } = await sb.storage
    .from('scenes')
    .upload(storagePath, imgBuf, { contentType: 'image/png', upsert: true });
  if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`);
  const { data: signedData, error: signErr } = await sb.storage
    .from('scenes')
    .createSignedUrl(storagePath, 3600); // 1 hour — plenty of time for Hailuo to fetch
  if (signErr) throw new Error(`Supabase signed URL failed: ${signErr.message}`);
  const imageUrl = signedData.signedUrl;
  console.log(`  Image URL: ${imageUrl}`);

  const submitRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KIEAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hailuo/02-image-to-video-standard',
      input: {
        prompt: 'Kavin the peacock surrounded by rainbow colors, gentle joyful animation, children cartoon style, safe for kids',
        image_url: imageUrl,
        duration: '6',
        resolution: '768P',
        prompt_optimizer: true,
      },
    }),
  });
  const submitData = await submitRes.json();
  if (submitData?.code !== 200) {
    throw new Error(`Hailuo submit failed: ${submitData?.msg || JSON.stringify(submitData)}`);
  }
  const taskId = submitData?.data?.taskId;
  if (!taskId) throw new Error(`No taskId: ${JSON.stringify(submitData)}`);
  console.log(`  Task: ${taskId}`);

  // Poll
  let videoUrl = null;
  for (let i = 1; i <= 90; i++) {
    await sleep(10000);
    const pollRes  = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${KIEAI_KEY}` },
    });
    const pollData = await pollRes.json();
    const state    = pollData?.data?.state;
    console.log(`  [${String(i).padStart(2)}] ${state}`);
    if (state === 'success') {
      let urls;
      try { urls = JSON.parse(pollData?.data?.resultJson)?.resultUrls; } catch {}
      videoUrl = urls?.[0];
      break;
    }
    if (state === 'fail') {
      throw new Error(`Hailuo job failed: ${pollData?.data?.failMsg} (code: ${pollData?.data?.failCode})`);
    }
  }
  if (!videoUrl) throw new Error('Hailuo job timed out after 15 min');

  console.log(`  Downloading video...`);
  const vidRes = await fetch(videoUrl);
  const vidBuf = Buffer.from(await vidRes.arrayBuffer());
  await fs.writeFile(rawClipPath, vidBuf);
  console.log(`  ✓ Raw clip: ${rawClipPath} (${(vidBuf.length / 1024 / 1024).toFixed(1)} MB)`);

  // 1c. Merge video + audio
  const endcardPath = join(OUTPUT_DIR, 'subscribe-endcard.mp4');
  console.log('\n🔗 Merging video + audio...');
  execSync(
    `"${FFMPEG}" -y -loglevel warning -i "${rawClipPath}" -i "${ttsPath}" -map 0:v -map 1:a -c:v copy -shortest "${endcardPath}"`,
    { stdio: 'pipe' }
  );
  console.log(`  ✓ subscribe-endcard.mp4 ready`);
}

// ─────────────────────────────────────────────────────────────────
// FIX 2 — Rebuild final video
// ─────────────────────────────────────────────────────────────────
async function fix2() {
  console.log('\n━━━ FIX 2: Rebuild Final Video ━━━\n');

  const watermarkedPath = join(OUTPUT_DIR, 'ep01-watermarked.mp4');
  const endcardPath     = join(OUTPUT_DIR, 'subscribe-endcard.mp4');
  const concatListPath  = join(OUTPUT_DIR, '_fix2-concat.txt');
  const finalPath       = join(OUTPUT_DIR, 'ep01-final.mp4');

  // Get duration
  const durStr = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${watermarkedPath}"`
  ).toString().trim();
  const dur = parseFloat(durStr);
  console.log(`  ep01-watermarked.mp4 duration: ${dur.toFixed(2)}s`);

  // Check last 3 seconds for silence
  let trimTo = dur;
  try {
    const silenceOut = execSync(
      `"${FFMPEG}" -y -loglevel warning -ss ${Math.max(0, dur - 3)} -i "${watermarkedPath}" -af "silencedetect=noise=-50dB:duration=1" -f null -`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const silences = (silenceOut.match(/silence_start: ([\d.]+)/g) || []);
    if (silences.length > 0) {
      const lastSilenceStart = parseFloat(silences[silences.length - 1].split(': ')[1]) + (dur - 3);
      trimTo = Math.max(dur - 3, lastSilenceStart);
      console.log(`  Trimming silence: cutting at ${trimTo.toFixed(2)}s`);
    } else {
      console.log(`  No trailing silence detected — keeping full duration`);
    }
  } catch (e) {
    // silence detection stderr — check it
    const stderr = e.stderr?.toString() || '';
    const matches = stderr.match(/silence_start: ([\d.]+)/g) || [];
    if (matches.length > 0) {
      const lastSilenceStart = parseFloat(matches[matches.length - 1].split(': ')[1]) + (dur - 3);
      trimTo = Math.max(dur - 3, lastSilenceStart);
      console.log(`  Trimming silence: cutting at ${trimTo.toFixed(2)}s`);
    } else {
      console.log(`  No trailing silence — keeping full duration`);
    }
  }

  // If trimming needed, trim first
  let sourceForConcat = watermarkedPath;
  if (trimTo < dur - 0.1) {
    const trimmedPath = join(OUTPUT_DIR, '_ep01-trimmed.mp4');
    console.log(`  Trimming to ${trimTo.toFixed(2)}s...`);
    execSync(
      `"${FFMPEG}" -y -loglevel warning -i "${watermarkedPath}" -t ${trimTo.toFixed(3)} -c copy "${trimmedPath}"`,
      { stdio: 'pipe' }
    );
    sourceForConcat = trimmedPath;
  }

  // Concat
  await fs.writeFile(concatListPath, `file '${sourceForConcat}'\nfile '${endcardPath}'\n`);
  console.log(`  Concatenating watermarked + subscribe-endcard...`);
  execSync(
    `"${FFMPEG}" -y -loglevel warning -f concat -safe 0 -i "${concatListPath}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k "${finalPath}"`,
    { stdio: 'pipe' }
  );
  await fs.unlink(concatListPath).catch(() => {});
  if (sourceForConcat !== watermarkedPath) {
    await fs.unlink(sourceForConcat).catch(() => {});
  }

  const finalDur = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${finalPath}"`
  ).toString().trim();
  const finalSize = (await fs.stat(finalPath)).size;
  console.log(`  ✓ ep01-final.mp4 | ${parseFloat(finalDur).toFixed(1)}s | ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
}

// ─────────────────────────────────────────────────────────────────
// FIX 3 — Regenerate thumbnail
// ─────────────────────────────────────────────────────────────────
async function fix3() {
  console.log('\n━━━ FIX 3: Regenerate Thumbnail ━━━\n');

  const thumbnailPath = join(OUTPUT_DIR, 'ep01-thumbnail.jpg');
  const pyScriptPath  = join(OUTPUT_DIR, '_thumb_gen.py');

  const pyCode = `
import sys, os
from PIL import Image, ImageDraw, ImageFont

BASE_IMAGE   = r'${SCENE03_IMG}'
LOGO_PATH    = r'${LOGO_PATH}'
OUTPUT_PATH  = r'${thumbnailPath}'
W, H = 1280, 720

# Load + center-zoom-crop to 1280x720
img = Image.open(BASE_IMAGE).convert('RGB')
iw, ih = img.size
scale = max(W / iw, H / ih)
nw, nh = int(iw * scale), int(ih * scale)
img = img.resize((nw, nh), Image.LANCZOS)
left = (nw - W) // 2
top  = (nh - H) // 2
img = img.crop((left, top, left + W, top + H))

# Dark gradient bottom 30% — use RGBA overlay
img = img.convert('RGBA')
overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
odraw = ImageDraw.Draw(overlay)
grad_top = int(H * 0.70)
for y in range(grad_top, H):
    a = int(210 * (y - grad_top) / (H - grad_top))
    odraw.rectangle([0, y, W, y + 1], fill=(0, 0, 0, a))
img = Image.alpha_composite(img, overlay).convert('RGB')

draw = ImageDraw.Draw(img)

# Rainbow bar — top 10px
colors = [(255,0,0),(255,127,0),(255,220,0),(0,200,0),(0,100,255),(75,0,130),(148,0,211)]
seg = W // len(colors)
for i, c in enumerate(colors):
    x0 = i * seg
    x1 = (i + 1) * seg if i < len(colors) - 1 else W
    draw.rectangle([x0, 0, x1, 10], fill=c)

def load_font(size):
    for p in [
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial Bold.ttf',
        '/Library/Fonts/Arial.ttf',
        '/System/Library/Fonts/SFNSDisplay.ttf',
        '/System/Library/Fonts/SFNS.ttf',
    ]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except: pass
    return ImageFont.load_default()

def load_tamil_font(size):
    for p in [
        '/Library/Fonts/Tamil Sangam MN.ttf',
        '/System/Library/Fonts/Supplemental/Tamil MN.ttc',
        '/Library/Fonts/Latha.ttf',
        '/Library/Fonts/NotoSansTamil-Regular.ttf',
        '/System/Library/Fonts/Supplemental/NotoSansTamil-Regular.ttf',
        '/Library/Fonts/NotoSansTamil.ttf',
    ]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except: pass
    return load_font(size)

def draw_stroked(draw, pos, text, font, fill, stroke_fill=(0,0,0), stroke=3):
    x, y = pos
    for dx in range(-stroke, stroke + 1):
        for dy in range(-stroke, stroke + 1):
            if dx != 0 or dy != 0:
                draw.text((x + dx, y + dy), text, font=font, fill=stroke_fill)
    draw.text((x, y), text, font=font, fill=fill)

# English title — top area
title = "Kavin Peacock and the Magic Rainbow"
tfont = load_font(60)
bbox = draw.textbbox((0, 0), title, font=tfont)
tw = bbox[2] - bbox[0]
tx = (W - tw) // 2
ty = 25
draw_stroked(draw, (tx, ty), title, tfont, fill=(255, 255, 255), stroke=3)

# Tamil subtitle — below English
tamil  = u"\\u0bb5\\u0ba3\\u0bcd\\u0ba3 \\u0bb5\\u0bbf\\u0bb2\\u0bcd\\u0bb2\\u0bc8 \\u0ba4\\u0bc7\\u0b9f\\u0bbf!"
tffont = load_tamil_font(52)
bbox2  = draw.textbbox((0, 0), tamil, font=tffont)
tw2    = bbox2[2] - bbox2[0]
tx2    = (W - tw2) // 2
ty2    = ty + 80
draw_stroked(draw, (tx2, ty2), tamil, tffont, fill=(255, 165, 0), stroke=3)

# Logo bottom-right 120px height
logo = Image.open(LOGO_PATH).convert('RGBA')
lh = 120
lw = int(logo.width * lh / logo.height)
logo = logo.resize((lw, lh), Image.LANCZOS)
img2 = img.convert('RGBA')
lx = W - lw - 20
ly = H - lh - 20
img2.paste(logo, (lx, ly), logo)
img = img2.convert('RGB')

img.save(OUTPUT_PATH, 'JPEG', quality=95)
print(f"  ✓ Thumbnail saved: {OUTPUT_PATH}")
print(f"  Size: {os.path.getsize(OUTPUT_PATH) // 1024} KB")
`;

  await fs.writeFile(pyScriptPath, pyCode);
  try {
    const out = execSync(`python3 "${pyScriptPath}"`, { encoding: 'utf8' });
    console.log(out.trim());
  } finally {
    await fs.unlink(pyScriptPath).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────
// FIX 4 — Update upload package
// ─────────────────────────────────────────────────────────────────
async function fix4() {
  console.log('\n━━━ FIX 4: Update Upload Package ━━━\n');

  const pkgPath = join(OUTPUT_DIR, 'ep01-upload-package.json');
  const pkg = {
    title: "Kavin Peacock and the Magic Rainbow 🌈 | Tamil Kids Story | Tiny Tamil Tales",
    description: "Kavin Peacock, oru super curious mayil, oru naal oru beautiful rainbow paakuRaan! 🦚🌈 Rainbow enge mudiyuthe-nu therinja aagaadhu-nu decide pannuRaan. Kitti the parrot-um Valli the bulbul-um serthu adventure-ku poRaanga! River cross pannuvaangalaa? Hill eruvaaangalaa? Naamma paakalaam vanga! 🦜🐦\n\n✨ Watch to find out what the REAL rainbow is!\n\n📱 Subscribe to Tiny Tamil Tales for more Tamil stories for kids every week!\n👍 Like if your little one enjoyed the story!\n🔔 Hit the bell so you never miss a new story!\n\n#TamilKidsStory #TinyTamilTales #TamilCartoon #KidsStoryTamil #RainbowStory #TamilBedtimeStory #TamilAnimation #KidsTamil #TamilStoriesForKids #TamilDiaspora #TamilKids #AnimatedStoryTamil #MoralStoryTamil #FriendshipStory #KavinPeacock",
    tags: [
      "tamil kids story","tamil cartoon","tiny tamil tales","rainbow story tamil",
      "kavin peacock","tamil bedtime story","tamil moral story","kids story tamil",
      "tamil animation","friendship story tamil","tamil stories for kids",
      "tamil diaspora kids","animated story tamil","tamil kids channel",
      "bedtime story tamil","kavin peacock tamil",
    ],
    thumbnail:    "output/ep01-thumbnail.jpg",
    videoFile:    "output/ep01-final.mp4",
    category:     "27",
    privacyStatus:"unlisted",
  };

  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  console.log(`  ✓ ep01-upload-package.json updated`);
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔧 EP01 Fix Run — 4 fixes\n');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  await fix1();
  await fix2();
  await fix3();
  await fix4();

  console.log('\n✅ All 4 fixes complete!\n');
}

main().catch(e => {
  console.error('\n💥 Fix failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
