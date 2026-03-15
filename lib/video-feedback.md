# Video Production Feedback Log
## Applied to all future videos autonomously

---

## Character Rules
- Peacock character name: **Kavin** (not Paandi)
- First mention of any character: always pair name + animal type
  - "Kavin, peacock," (comma after each)
  - "Kitti, kili," (kili = parrot in Tamil)
  - "Valli, kuruvi," (kuruvi = small bird)
- "Children" in story = small sparrows/birds — NEVER human children
- Introduce ALL characters in the first 5 scenes — no characters appearing from nowhere

## Tamil Language Rules
- **Romanized only** — no Tamil Unicode script characters ever
- **Avoid ழ words**: mazhai→rain, azhaga→pretty/beautiful, ezhunthaan→veliye vanthaan, vazhi→road/way
- **Colloquial contractions**: irukulla (not irukku illa), solluven (not sollugiRen), poyitaan (not poyinaar)
- **No literary openings**: no "oru X naal" style — start warm and direct
- **penji ninnuchi** (not mudinchitchu) for "stopped/ended"
- **paarunga** (not parunga) — double aa for correct pronunciation
- **iruku-la** or **irukulla** (not irukku illa?) for question tags
- **mudiuma** (not aaguma) for "can we / is it possible"
- Mix of colloquial Tamil + Tanglish — not pure formal Tamil

## ElevenLabs TTS Settings (LOCKED — do not change)
- Model: `eleven_v3`
- Endpoint: `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=mp3_44100_128`
- Body: `{ text, model_id: "eleven_v3", voice_settings: {} }`
- NO language_code field
- NO custom stability/similarity/style values — empty voice_settings uses voice defaults
- Voice map (all TTT voices trained for this channel):
  - narrator → XCVlHBLvc3SVXhH7pRkb (Narrator Female TTT)
  - kavin → oDV9OTaNLmINQYHfVOXe (Cubbie Final Voice TTT)
  - kitti → T4QhgFpOCsg0hCcSOUYw (Hunter 1 TTT)
  - valli → DNLl3gCCSh2dfb1WDBpZ (Mridula)
  - sparrows → KNmZI8RXLqk94uYj1GaH (Hunter 2 TTT)
  - elder → JL7VCc7O6rY87Cfz9kIO (Mukundan)

## Script Review Process (MANDATORY from next video — 2026-03-15)

The pipeline must STOP after Stage 2 and wait for Darl's script approval before proceeding to images/animation.

### New flow:
1. Stage 2 generates script → saves to Supabase
2. **Friday extracts all 24 scene dialogues and sends to Darl for review** (same format as EP01 scene-by-scene list)
3. Darl corrects and returns
4. Friday updates the script in Supabase with corrections
5. THEN stages 3-9 proceed

### Why this matters
- TTS is cheap to redo (ElevenLabs chars)
- Hailuo clips are expensive ($0.10 each × 24 = $2.40)
- Images cost Imagen quota (70/day)
- Fixing dialogue AFTER images/animation wastes budget and time
- Script review takes 20 mins. It saves hours of rework.

### Script quality checklist (Friday reviews before sending to Darl)
- [ ] All characters introduced with full animal name in first 5 scenes
- [ ] "sernthu" not "serthu" throughout
- [ ] No ழ words (mazhai, vazhi, azhaga etc.)
- [ ] Colloquial Tamil only — no formal/literary phrasing
- [ ] Sparrows use "naangalum" not "naamum"
- [ ] No unnecessary English words — use Tamil equivalents
- [ ] Each scene max 25 Tamil words
- [ ] Emotion matches scene context
- [ ] No repetition from previous scenes unless intentional character trait

## Script Generation Rules
- Exactly 24 scenes per video
- Each scene text: 20-30 romanized words → fills ~8-9 seconds spoken
- Story arc: scenes 1-5 intro, 6-14 rising action, 15-20 climax, 21-24 resolution
- Environment tag per scene: forest_day / forest_rain / river / night / sky / crowd_children

## Character Consistency Rules (CRITICAL — 2026-03-15)

Imagen generates each image independently. Without exact repeated character descriptions, the same character looks different scene to scene.

### Rule: Every video must have a locked character sheet
- Before Stage 2 runs, define a one-line visual description for EACH character in the episode
- This description is injected into EVERY scene's visual_description that features that character — verbatim, no rewording
- Stage 2 prompt must include the character sheet so Claude copies descriptions exactly

### What a character description must include
- Animal species (exact)
- Key colors (body, beak/bill, markings)
- Distinguishing features (crest, tail, wing pattern, eye color)
- Art style tag (same for all): "cartoon storybook style, 3D rendered, warm colors, child-friendly"

### Example format (adapt for any character):
"[name] — a [color] [species] with [key feature 1], [key feature 2], [art style tag]"

### Rules
- NEVER just use the character name in visual_description ("Kavin looks excited") — always include the full physical description
- NEVER vary wording between scenes — copy-paste the locked description every time
- If a scene has multiple characters, include ALL their descriptions
- Art style tag must be IDENTICAL across all scenes: "cartoon storybook style, 3D rendered, warm colors, child-friendly"
- Character sheet lives in Stage 1 concept output and is passed to Stage 2

## Visual Description Rules (CRITICAL)
- Always name the exact animal species — never "character" or "friend"
  - ✅ "a colorful peacock with spread fan tail feathers"
  - ✅ "a bright green parrot with expressive eyes"
  - ✅ "a small brown bulbul songbird"
  - ✅ "three tiny sparrows perched on a branch"
  - ❌ "Kavin and his friends" (too vague)
  - ❌ "children watching" (generates human children)
- Describe the exact action happening in the scene
- Include: lighting, environment, mood
- All characters are ANIMALS — no humans ever

## Resolution Rules (LOCKED — 2026-03-15)
- ALL videos must be 1280x720 (16:9) — no square videos ever on YouTube
- Stage 4 (Imagen): aspectRatio: '16:9' — already set ✅
- Stage 5 (Hailuo): source images must be 16:9 — Hailuo preserves input aspect ratio
- Stage 7 (Assembly): normalize every clip to 1280x720 before assembly using:
  scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720
  (center-crop to 16:9 — handles any square/portrait clips gracefully)
- Post-process: end card re-encoded at 1280x720 ✅

## Assembly Rules
- Each scene duration = max(clip_duration, audio_duration) — never cut dialogue
- Clip loops to cover audio if audio > clip
- SFX ambient: vol 0.3 per scene (was 0.15 — too quiet)
- BGM: vol 0.12 per scene + 0.1 final continuous track with fade in/out

## Image Validation (Stage 4)
- After each image generated, validate with vision model:
  - Are characters animals/birds (not humans)?
  - Does scene visually match description?
  - If humans detected → regenerate with more explicit animal-only prompt

## End Card Rules (LOCKED — 2026-03-15)
- **Always use `assets/end-card.mp4`** — the official Tiny Tamil Tales branded end card
- Scale to 1280x720 before concat (source is 4K, 7.1s)
- **Never generate end cards via FFmpeg text overlays or Hailuo** — they look bad
- assets/end-card.mp4 is the permanent end card for ALL videos going forward

## Logo Watermark Rules (LOCKED — 2026-03-15)
- Position: top-right, 20px margins
- Size: 80px height, width auto-scaled
- Opacity: **100% fully visible** — no transparency filter. Use PNG alpha channel as-is.
  FFmpeg filter: [1:v]scale=-1:80[logo];[0:v][logo]overlay=W-w-20:20[out]
- Logo file: assets/channel-logo.png

## End Card Assembly Fix
- Last scene must NOT have dead silence after audio ends before end card
- Trim last scene clip to max(clip_duration, audio_duration) — no extra padding
- End card clip appended IMMEDIATELY after last scene — zero gap
- If gap exists → ffmpeg concat filter with setpts=PTS-STARTPTS to eliminate it

## Thumbnail Rules (LOCKED — 2026-03-15, updated 2026-03-15)

### Image
- Always use the MAIN character of the episode — never a side character
- Pick the most expressive close-up scene (excited face, action moment) — not a standing pose
- Character should fill 60-70% of frame — close crop, not wide shot
- Stage 4 must generate images correctly — validate character identity before saving

### Text Layout
- **Title line**: "[Character]'s Adventure!" or "[Character]'s [Hook]!" — ONE LINE, white, Impact font, black stroke 5px
- **Tagline line**: short hook below, yellow/gold, Impact font smaller, black stroke 4px — this is where the story keyword goes (e.g. "Chasing the Magic Rainbow")
- NEVER split the title across two different colours — looks like two separate things
- NEVER put filler words ("and the", "a", "the") as the dominant text
- Max 5 words per line — anything longer shrinks unreadably at small sizes
- Both lines left-aligned, positioned in lower-left over dark gradient

### Logo
- **Top-right corner**, 100px height, 18px margin — NEVER bottom-right (covered by YouTube timestamp)

### Background treatment
- Dark gradient over bottom 40% of image so text is always readable
- NO rainbow bar or decorative strips along edges — looks amateurish
- No Tamil text on thumbnail — font rendering is broken, fix later

### Colors
- Title: pure white (#FFFFFF) with black stroke
- Tagline: gold/yellow (#FFD700) with black stroke
- Gradient: black, opacity 0-82% bottom to top over lower 40%

### What NOT to do
- ❌ Rainbow colour bar along top/bottom edges
- ❌ Tamil Unicode text (broken rendering)
- ❌ Logo at bottom-right
- ❌ Two-colour title that looks split
- ❌ Full YouTube title crammed onto thumbnail
- ❌ Static neutral pose — pick expressive moment

## Video Title Rules (LOCKED — 2026-03-15)
- Always include character's FULL identity: "Kavin Peacock" not just "Kavin"
- YouTube title format: "[Character]'s [Hook]! 🦚 | Tamil Kids Story | Tiny Tamil Tales"
- Thumbnail title format: "[Character]'s [Hook]!" — one line, no pipes, no channel name
- Thumbnail tagline: keyword from story (e.g. "Chasing the Magic Rainbow") — yellow, smaller
- Hook should be action/curiosity-driven — NOT just the story summary
- Examples:
  - ✅ YouTube: "Kavin Peacock's Adventure! 🦚 | Tamil Kids Story | Tiny Tamil Tales"
  - ✅ Thumbnail title: "Kavin Peacock's Adventure!"
  - ✅ Thumbnail tagline: "Chasing the Magic Rainbow"
  - ❌ "Kavin and the Rainbow" — no identity, no hook
  - ❌ Splitting title across two colours on thumbnail
- Description must use "Kavin Peacock" (full name) in the first sentence

---
## YouTube Publishing Rules (HARD RULES — set by Darl)
- **Friday NEVER makes a video public** — Darl does this manually, always
- **Friday NEVER deletes YouTube content** — Darl's decision only
- Friday uploads as UNLISTED → Darl reviews → Darl publishes
- No exceptions. Not even "Darl said it's ready". Still unlisted until Darl clicks publish himself.

_Last updated: 2026-03-15_
