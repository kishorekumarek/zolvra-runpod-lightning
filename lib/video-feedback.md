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

## Script Generation Rules
- Exactly 24 scenes per video
- Each scene text: 20-30 romanized words → fills ~8-9 seconds spoken
- Story arc: scenes 1-5 intro, 6-14 rising action, 15-20 climax, 21-24 resolution
- Environment tag per scene: forest_day / forest_rain / river / night / sky / crowd_children

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

---
_Last updated: 2026-03-15_
