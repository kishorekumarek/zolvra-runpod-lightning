#!/usr/bin/env node
// scripts/generate-thumbnail.mjs — Generate EP01 YouTube thumbnail
// Usage: node scripts/generate-thumbnail.mjs
// Requires: ImageMagick (convert) or Python Pillow
import 'dotenv/config';
import { execSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_ID = 'eb42af4b-f4ce-4e0f-b2f7-1f3e452030f8';
const OUTPUT_DIR = join(__dirname, '..', 'output');
const LOGO_PATH  = join(__dirname, '..', 'assets', 'channel-logo.png');
const OUT_PATH   = join(OUTPUT_DIR, 'ep01-thumbnail.jpg');

// ── Source image resolution ──────────────────────────────────────────────────

async function findSourceImage() {
  // Priority 1: scene_03_img.png from workspace memory
  const memorySrc = '/Users/friday/.openclaw/workspace/memory/scene_03_img.png';
  try {
    await fs.access(memorySrc);
    console.log(`  Source: ${memorySrc}`);
    return memorySrc;
  } catch { /* not found */ }

  // Priority 2: any scene image in tmp dir for this task
  const tmpScenes = `/tmp/zolvra-pipeline/${TASK_ID}/scenes`;
  const tmpFiles = await fs.readdir(tmpScenes).catch(() => []);
  const imgs = tmpFiles.filter(f => /\.(png|jpg|jpeg)$/i.test(f)).sort();
  if (imgs.length > 0) {
    const p = join(tmpScenes, imgs[0]);
    console.log(`  Source: ${p} (from tmp scenes)`);
    return p;
  }

  // Priority 3: any frame_*.jpg in output/
  const outFiles = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const frames = outFiles.filter(f => /^frame_\d+\.(jpg|png)$/i.test(f)).sort();
  if (frames.length > 0) {
    const p = join(OUTPUT_DIR, frames[0]);
    console.log(`  Source: ${p} (from output frames)`);
    return p;
  }

  throw new Error(
    'No source image found. Expected scene_03_img.png at ' + memorySrc +
    '\nRun stage 4 (illustrate) first or place a scene image in output/.'
  );
}

// ── Tool detection ───────────────────────────────────────────────────────────

function hasCommand(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function getConvertPath() {
  // Homebrew ImageMagick first, then system
  for (const p of ['/opt/homebrew/bin/convert', '/usr/local/bin/convert', 'convert']) {
    const r = spawnSync('which', [p === 'convert' ? 'convert' : p], { encoding: 'utf8' });
    if (r.status === 0) return p;
    // Also try direct path
    try { execSync(`"${p}" --version 2>/dev/null`, { stdio: 'pipe' }); return p; } catch { /* nope */ }
  }
  return null;
}

// ── Tamil font detection ─────────────────────────────────────────────────────

async function findTamilFont() {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Tamil MN.ttc',
    '/System/Library/Fonts/Tamil.ttc',
    '/Library/Fonts/Latha.ttf',
    '/usr/share/fonts/truetype/lato/Lato-Bold.ttf',
  ];
  for (const f of candidates) {
    try { await fs.access(f); return f; } catch { /* not found */ }
  }
  return null; // fall back to default; Tamil may not render correctly
}

// ── ImageMagick thumbnail generation ────────────────────────────────────────

async function generateWithImageMagick(convertPath, sourcePath) {
  console.log('\n🎨 Using ImageMagick');

  const tmpBase = join(OUTPUT_DIR, '_thumb_tmp');
  await fs.mkdir(tmpBase, { recursive: true });

  const step1 = join(tmpBase, 'step1_crop.png');      // resized + cropped
  const step2 = join(tmpBase, 'step2_grad.png');       // + gradient overlay
  const step3 = join(tmpBase, 'step3_rainbow.png');    // + rainbow bar
  const step4 = join(tmpBase, 'step4_title.png');      // + English title
  const step5 = join(tmpBase, 'step5_tamil.png');      // + Tamil text
  const step6 = join(tmpBase, 'step6_logo.png');       // + channel logo

  const tamilFont = await findTamilFont();
  const boldFont  = '/System/Library/Fonts/Helvetica.ttc';

  // 1. Resize + center crop to 1280x720
  console.log('  [1/6] Crop to 1280x720...');
  execSync(
    `"${convertPath}" "${sourcePath}" -resize "1280x720^" -gravity Center -extent 1280x720 "${step1}"`,
    { stdio: 'pipe' }
  );

  // 2. Dark gradient overlay on bottom 30% (216px)
  console.log('  [2/6] Dark gradient overlay (bottom 30%)...');
  execSync([
    `"${convertPath}" "${step1}"`,
    `\\( -size 1280x216 gradient:"rgba(0,0,0,0)-rgba(0,0,0,0.80)" \\)`,
    `-gravity South -composite "${step2}"`,
  ].join(' '), { stdio: 'pipe' });

  // 3. Rainbow color bar at top (10px)
  console.log('  [3/6] Rainbow bar (top 10px)...');
  // Build a 7-color rainbow gradient using convert's -fill and -draw
  const rainbowColors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#8B00FF'];
  const segW = Math.ceil(1280 / rainbowColors.length);
  let rainbowCmd = `"${convertPath}" "${step2}"`;
  rainbowColors.forEach((c, i) => {
    const x1 = i * segW;
    const x2 = Math.min(x1 + segW, 1280) - 1;
    rainbowCmd += ` -fill "${c}" -draw "rectangle ${x1},0 ${x2},9"`;
  });
  rainbowCmd += ` "${step3}"`;
  execSync(rainbowCmd, { stdio: 'pipe' });

  // 4. English title text — top area, bold white with black stroke
  console.log('  [4/6] Title text...');
  const fontArg = boldFont ? `-font "${boldFont}"` : '';
  execSync([
    `"${convertPath}" "${step3}"`,
    fontArg,
    `-pointsize 72`,
    `-fill white`,
    `-stroke black -strokewidth 4`,
    `-gravity NorthWest`,
    `-annotate +40+30 "Kavin and the Rainbow"`,
    `"${step4}"`,
  ].join(' '), { stdio: 'pipe' });

  // 5. Tamil text below English title
  console.log('  [5/6] Tamil text...');
  const tamilFontArg = tamilFont ? `-font "${tamilFont}"` : '';
  if (!tamilFont) {
    console.warn('  ⚠️  No Tamil font found — Tamil text may not render correctly');
  }
  execSync([
    `"${convertPath}" "${step4}"`,
    tamilFontArg,
    `-pointsize 52`,
    `-fill "#FF6B35"`,
    `-stroke black -strokewidth 2`,
    `-gravity NorthWest`,
    `-annotate +40+120 "வண்ண வில்லை தேடி!"`,
    `"${step5}"`,
  ].join(' '), { stdio: 'pipe' });

  // 6. Channel logo — bottom-right, 120px height
  console.log('  [6/6] Channel logo (bottom-right)...');
  execSync([
    `"${convertPath}" "${step5}"`,
    `\\( "${LOGO_PATH}" -resize "x120" \\)`,
    `-gravity SouthEast -geometry +20+20`,
    `-composite "${step6}"`,
  ].join(' '), { stdio: 'pipe' });

  // Final: convert to JPEG at 85% quality
  execSync(
    `"${convertPath}" "${step6}" -quality 85 "${OUT_PATH}"`,
    { stdio: 'pipe' }
  );

  // Cleanup tmp
  await fs.rm(tmpBase, { recursive: true, force: true });
}

// ── Python Pillow fallback ────────────────────────────────────────────────────

async function generateWithPython(sourcePath) {
  console.log('\n🐍 Using Python Pillow');

  const script = `
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

source = sys.argv[1]
logo_path = sys.argv[2]
out_path = sys.argv[3]

# 1. Load and crop to 1280x720 zoomed center
img = Image.open(source).convert('RGB')
target_w, target_h = 1280, 720
ratio = max(target_w / img.width, target_h / img.height)
new_w = int(img.width * ratio)
new_h = int(img.height * ratio)
img = img.resize((new_w, new_h), Image.LANCZOS)
left = (new_w - target_w) // 2
top = (new_h - target_h) // 2
img = img.crop((left, top, left + target_w, top + target_h))

# 2. Dark gradient overlay bottom 30%
overlay = Image.new('RGBA', (target_w, target_h), (0, 0, 0, 0))
draw_ov = ImageDraw.Draw(overlay)
grad_start = int(target_h * 0.70)
for y in range(grad_start, target_h):
    alpha = int(200 * (y - grad_start) / (target_h - grad_start))
    draw_ov.line([(0, y), (target_w, y)], fill=(0, 0, 0, alpha))
img = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')

# 3. Rainbow bar top 10px
draw = ImageDraw.Draw(img)
rainbow = ['#FF0000','#FF7F00','#FFFF00','#00FF00','#0000FF','#4B0082','#8B00FF']
seg_w = target_w // len(rainbow)
for i, c in enumerate(rainbow):
    draw.rectangle([i*seg_w, 0, (i+1)*seg_w, 9], fill=c)

# 4. Load fonts (best-effort)
def load_font(size, bold=False):
    candidates = [
        '/System/Library/Fonts/Helvetica.ttc',
        '/System/Library/Fonts/Arial.ttf',
        '/Library/Fonts/Arial Bold.ttf',
    ]
    for f in candidates:
        if os.path.exists(f):
            try: return ImageFont.truetype(f, size)
            except: pass
    return ImageFont.load_default()

def load_tamil_font(size):
    candidates = [
        '/System/Library/Fonts/Supplemental/Tamil MN.ttc',
        '/System/Library/Fonts/Tamil.ttc',
        '/Library/Fonts/Latha.ttf',
    ]
    for f in candidates:
        if os.path.exists(f):
            try: return ImageFont.truetype(f, size)
            except: pass
    return load_font(size)

title_font = load_font(72, bold=True)
tamil_font = load_tamil_font(52)

# 5. English title — white with black shadow
title = "Kavin and the Rainbow"
x, y = 40, 30
for dx, dy in [(-3,-3),(3,-3),(-3,3),(3,3),(0,-4),(0,4),(-4,0),(4,0)]:
    draw.text((x+dx, y+dy), title, font=title_font, fill='black')
draw.text((x, y), title, font=title_font, fill='white')

# 6. Tamil text — orange with black stroke
tamil = "வண்ண வில்லை தேடி!"
tx, ty = 40, 120
for dx, dy in [(-2,-2),(2,-2),(-2,2),(2,2)]:
    draw.text((tx+dx, ty+dy), tamil, font=tamil_font, fill='black')
draw.text((tx, ty), tamil, font=tamil_font, fill='#FF6B35')

# 7. Channel logo bottom-right 120px
logo = Image.open(logo_path).convert('RGBA')
logo_h = 120
logo_w = int(logo.width * logo_h / logo.height)
logo = logo.resize((logo_w, logo_h), Image.LANCZOS)
pos = (target_w - logo_w - 20, target_h - logo_h - 20)
img.paste(logo, pos, logo)

# 8. Save as JPEG 85%
img.save(out_path, 'JPEG', quality=85)
print(f"Saved: {out_path}")
`;

  const scriptPath = join(OUTPUT_DIR, '_thumb_gen.py');
  await fs.writeFile(scriptPath, script);

  try {
    execSync(
      `python3 "${scriptPath}" "${sourcePath}" "${LOGO_PATH}" "${OUT_PATH}"`,
      { stdio: 'inherit' }
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🖼️  EP01 Thumbnail Generator\n');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const sourceImage = await findSourceImage();
  console.log(`✓ Source image: ${sourceImage}`);

  // Try ImageMagick first
  const convertPath = getConvertPath();
  if (convertPath) {
    console.log(`✓ ImageMagick found: ${convertPath}`);
    await generateWithImageMagick(convertPath, sourceImage);
  } else if (hasCommand('python3')) {
    // Check if Pillow is available
    const pillowCheck = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
    if (pillowCheck.status === 0) {
      console.log('✓ Python Pillow available');
      await generateWithPython(sourceImage);
    } else {
      throw new Error(
        'Neither ImageMagick nor Python Pillow is available.\n' +
        'Install one: brew install imagemagick  OR  pip3 install pillow'
      );
    }
  } else {
    throw new Error(
      'Neither ImageMagick nor Python 3 is available.\n' +
      'Install ImageMagick: brew install imagemagick'
    );
  }

  const size = (await fs.stat(OUT_PATH)).size;
  console.log(`\n✅ Thumbnail generated!`);
  console.log(`   Output: ${OUT_PATH}`);
  console.log(`   Size  : ${(size / 1024).toFixed(0)} KB`);
}

main().catch(e => {
  console.error('\n💥 Thumbnail generation failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
