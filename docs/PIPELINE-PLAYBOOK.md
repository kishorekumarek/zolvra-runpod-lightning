# YouTube Pipeline Playbook — Tiny Tamil Tales

_Source of truth for autonomous video production. Updated after every episode._
_Last updated: 2026-03-17 (EP02 "Minmini")_

---

## Goal

Fully autonomous weekly content creation for @tinytamiltales YouTube channel.
Each episode: concept → script → voice → illustration → animation → assembly → upload → notify.
Friday orchestrates, Ash executes code changes, Darl reviews final video.

---

## Episode Format

| Parameter | Value |
|-----------|-------|
| Format | YouTube Shorts (9:16 vertical) |
| Duration | ≤60 seconds |
| Scenes | 8 per episode |
| Language | Colloquial Tamil + Tanglish (diaspora kids) |
| Audience | Tamil kids 3-7, parents in UAE/UK/US/Canada/Singapore/Australia |
| Upload status | UNLISTED always — Darl publishes manually |
| Tags | Always include `#Shorts` in description |

---

## Voice — ElevenLabs v3

### API Format (LOCKED)
```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=mp3_44100_128" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "[audio_tag] Tamil text with... pauses and EMPHASIS",
    "model_id": "eleven_v3",
    "voice_settings": {}
  }'
```

### Critical Rules
- **voice_settings must be `{}`** (empty object) — all emotion via text tags
- **No SSML** — v3 does NOT support SSML break tags
- **No language_code** — v3 auto-detects language
- **No stability/speed/style params** — these are v2 settings, will break v3

### Audio Tags (emotion control)
| Tag | Use for |
|-----|---------|
| `[excited]` | Joy, energy, enthusiasm |
| `[surprised]` | Wonder, awe, discovery |
| `[whispers]` | Soft, gentle, secret |
| `[sighs]` | Sadness, realization, relief |
| `[mischievously]` | Playful, scheming |
| `[curious]` | Questioning, exploring |
| `[gently]` | Kind, soft, caring |
| `[hopeful]` | Optimistic, asking |
| `[thoughtful]` | Reflective, wisdom |
| `[laughing]` / `[giggling]` | Laughter, joy |
| `[softly amazed]` | Quiet wonder |

### Text Controls
- **Pauses:** Use `...` (ellipses). More dots = longer pause.
- **Emphasis:** Use CAPITAL LETTERS for stressed words.
- **Hyphens:** Use `-` for syllable breaks (e.g., `Pudi-nga`)
- **Tamil script OK:** Can mix Tamil script (போங்க) with transliteration

### Voice IDs (CURRENT — verified 2026-03-17)
| Character | Voice ID | Notes |
|-----------|----------|-------|
| Arjun | oDV9OTaNLmINQYHfVOXe | Male child |
| Kaavya | 2zRM7PkgwBPiau2jvVXc | Female child |
| Meenu | Sm1seazb4gs7RSlUVw7c | Female child (younger) |
| Narrator | XCVlHBLvc3SVXhH7pRkb | Female narrator |
| Kavin | oDV9OTaNLmINQYHfVOXe | Same as Arjun (Cubbie) |
| Children | KNmZI8RXLqk94uYj1GaH | Group children (Hunter 2) |
| Elder | JL7VCc7O6rY87Cfz9kIO | Older male (Mukundan) |

⚠️ **DEAD VOICE IDs — DO NOT USE:**
- `DNLl3gCCSh2dfb1WDBpZ` (old Mridula) — returns 404
- `T4QhgFpOCsg0hCcSOUYw` (old Hunter 1) — not verified

### Pre-flight Check
Before generating any voice samples:
1. Test each voice ID with a simple Tamil phrase
2. If 404 → ask Darl for updated voice ID
3. Generate 1 sample first, verify quality, then batch all 8

---

## Script Writing Rules

1. **8 scenes exactly** — each scene = 1 speaker + 1 dialogue line
2. **Colloquial Tamil + Tanglish** — NOT formal/literary Tamil
3. **Each dialogue:** 10-30 Tamil words max (fits in 5-10s audio)
4. **Include audio tags** in the dialogue text itself
5. **Include pauses** via `...` where emotionally appropriate
6. **Include EMPHASIS** via CAPITALS for key emotional words
7. **Character names:** Kaavya (not Kaviya), Minmini (not Minminni)
8. **Moral/wisdom:** Final scene should carry the episode's lesson
9. **Tamil script OK** for words that need precise pronunciation

---

## Assembly Pipeline

### Inputs
- 8 scene animations from Supabase `scenes` bucket: `{taskId}/scene_XX_anim.mp4`
- 8 voice samples from ElevenLabs v3 (local: `output/epXX-samples-v3/`)
- BGM: `assets/bgm/kids_folk_02.mp3`
- Logo: `assets/channel-logo.png`
- End card video: `assets/shorts_end_card.mp4`
- End card audio: `assets/end_card_audio.mp3`

### Steps
1. **Download** 8 scene animations from Supabase `scenes` bucket
2. **Sync** each scene: trim video to voice duration. If voice > video, loop video with `-stream_loop -1 -shortest`
3. **Concatenate** all 8 scenes
4. **Add BGM** at 15% volume: `volume=0.15`, `amix=inputs=2:duration=first`
5. **Add logo** overlay: top-right, ~12% of video width, 20px padding
6. **Re-encode** to normalize codec: `libx264 -preset fast -crf 23 -r 30`
7. **Re-encode end card** to match main video resolution/codec
8. **Concatenate** main + end card
9. **Final sync fix:** Re-encode with `-shortest` to eliminate drift
10. **Validate:** Sync drift must be < 0.5s

### Output
- Final MP4: `output/epXX-assembly-final/epXX-TITLE-FINAL-synced.mp4`
- Format: 9:16 vertical, ≤60s, HD

---

## Upload & Notification

### YouTube Upload
- **Privacy:** UNLISTED always. Darl publishes manually.
- **Category:** 27 (Education)
- **Language:** ta (Tamil)
- **Tags:** Include `#Shorts` in description + relevant Tamil/English keywords
- **Made for Kids:** true (once public)
- **Library:** `lib/youtube.mjs` → `uploadVideoUnlisted()`

### Telegram Notification
- **Chat ID:** 7879469053 (Darl's Telegram)
- **Bot Token:** In openclaw.json → `channels.telegram.botToken`
- **Message:** Include YouTube URL, status, duration, scene count, voice info

---

## Supabase Storage

| Bucket | Content | Path Pattern |
|--------|---------|-------------|
| `scenes` | Scene animations + images | `{taskId}/scene_XX_anim.mp4` |
| `scenes` | Scene source images | `{taskId}/scene_XX_image.png` |

⚠️ **There is no `zolvra-youtube` bucket** — always use `scenes`

---

## Common Mistakes to Avoid

1. ❌ Using English voices for Tamil content
2. ❌ Using `eleven_multilingual_v2` — always use `eleven_v3`
3. ❌ Sending stability/speed/style in voice_settings — must be `{}`
4. ❌ Using SSML tags — v3 doesn't support them
5. ❌ Using assembled final video as input for assembly (it's the OUTPUT)
6. ❌ Forgetting `#Shorts` tag in YouTube description
7. ❌ Looking for scenes on local filesystem — they're in Supabase `scenes` bucket
8. ❌ Using Haiku for complex pipeline orchestration — use Opus
9. ❌ Asking "should I...?" when the pipeline is clear — just execute
10. ❌ Uploading as public — ALWAYS unlisted, Darl publishes

---

## Episode History

| EP | Title | URL | Date | Status |
|----|-------|-----|------|--------|
| 01 | Kavin the Peacock's Feather Gift | https://youtu.be/F7ZXQVMT9o8 | 2026-03-15 | Unlisted |
| 02 | Minmini (Fireflies) | https://youtu.be/eagFew2y21U | 2026-03-17 | Unlisted |

---

## Autonomy Roadmap

### Currently Manual
- Script writing (Darl reviews dialogue)
- Voice ID verification
- Assembly triggering
- End-to-end orchestration

### Target: Fully Autonomous
1. [ ] End-to-end pipeline script: concept → script → voice → image → animate → assemble → upload → notify
2. [ ] Update `lib/tts.mjs` to v3 format
3. [ ] Update `lib/voice-config.mjs` with current voice IDs
4. [ ] Update `stage-06-voice.mjs` to use v3 audio tags
5. [ ] Auto-add `#Shorts` to all uploads
6. [ ] Assembly stage auto-downloads from Supabase
7. [ ] Voice ID health check before batch generation
8. [ ] Automated quality checks (duration, sync, format)
9. [ ] Weekly cron: generate + upload 1 episode autonomously
10. [ ] Darl only reviews + publishes — everything else autonomous
