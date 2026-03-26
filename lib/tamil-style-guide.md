# Tamil Script Style Guide — Tiny Tamil Tales
## For Claude (Stage 2 script generation)

---

## The Voice
Tamil diaspora kids in UAE, UK, US, Canada, Australia.
They speak Tamil at home but think in English.
The script must sound like their Tamil parent telling a bedtime story — warm, natural, fun.
NOT a school textbook. NOT a literature class. NOT a newsreader.

---

## Rule 1 — Tamil Script Only. English Loanwords Allowed.
Write all dialogue in Tamil Unicode script.
English loanwords (rainbow, super, okay, boring, friends, time, spend) can stay in English letters — this is natural Tanglish.

✅ Right: "தன்னோட friends-கிட்ட ஓடி வந்துச்சு"
✅ Right: "ரொம்ப pretty-ஆ இருக்கு!"
❌ Wrong: "thannoda friends-kita odi vanthuchi" (romanized — do NOT use)

---

## Rule 2 — Avoid ழ (zha) Words. Use English or Simpler Tamil Instead.
The Tamil ழ sound is unique and most TTS models mispronounce it.
When a word has ழ, replace it with an English word or a simpler Tamil word.

| ❌ Avoid (has ழ)        | ✅ Use instead            |
|------------------------|--------------------------|
| மழை (rain)             | rain                     |
| வழி (way/path)         | road, way                |
| எழில் / அழகா (beautiful) | pretty-ஆ, beautiful-ஆ  |
| தாழ் (low/below)        | கீழே, below             |
| பழகு (practice)        | practice பண்ணு           |
| எழுந்தான் (got up)      | வெளியே வந்தான், stand up பண்ணான் |
| விழா (festival/fall)   | festival, கீழே விழுந்தான் |

---

## Rule 3 — Colloquial Contractions Only. No Formal Grammar.

| ❌ Formal (textbook)      | ✅ Colloquial (how people talk)  |
|--------------------------|--------------------------------|
| இருக்கு இல்லா?           | இருக்குல்ல?                     |
| சொல்லுகிறேன்              | சொல்லுவேன் / சொல்லுறேன்         |
| வந்தார்கள்                | வந்தாங்க                       |
| போகிறான்                  | போறான் / போறான்                  |
| பார்க்கிறான்              | பாக்குறான்                      |
| செய்கிறான்                | பண்றான் / பண்ணுறான்              |
| என்ன செய்வோம்?            | என்ன பண்ணலாம்?                  |
| வந்தாய்                  | வந்தியா / வந்தே                 |

---

## Rule 4 — No Literary Story Openings.
Avoid formal once-upon-a-time phrases. Start warm and direct.

| ❌ Avoid                                  | ✅ Use instead                                              |
|------------------------------------------|-------------------------------------------------------------|
| ஒரு மழை நாள்...                          | ஒரு நாள், காட்டுல rain பெஞ்சிட்டு இருந்துச்சு...            |
| ஒரு சிறு பறவை இருந்தது...                | Kavin ஒரு நாள் காட்டுல திரிஞ்சு இருந்தான்...               |
| கடலோரத்தில் ஒரு...                       | Sea-கிட்டே ஒரு...                                          |

---

## Rule 5 — Each Character Has a Distinct Voice Pattern

**Narrator** — warm, slightly poetic, colloquial Tamil with English nouns
> "Kavin காட்டுல தன்னோட friends-ஓட enjoy பண்ணிட்டு இருந்தான்.
>  அன்னிக்கி வானத்துல ஒரு big rainbow வந்துச்சு — ரொம்ப pretty-ஆ!"

**Kavin (curious, gentle, young male)** — Tanglish, enthusiastic but sweet
> "ஐய்யோ, பாருங்க! Sky பாருங்க — rainbow இருக்கு! Super-ஆ இருக்குல்ல?"
> "நான் இந்த rainbow-ஆ touch பண்ணனும், முடியுமா?"

**Kitti (parrot, chatty, fast talker)** — rapid Tanglish, repeats things, excited
> "ஆமா ஆமா! நான் பாத்தேனே! Blue, red, yellow — எல்லாமே இருக்கு இருக்கு!"
> "என்ன colour என்ன colour! யாரு போட்டாங்க தெரியுமா?"

**Valli (bulbul, gentle, soft female)** — slower pace, soft Tamil, caring
> "Kavin, நீ வேற level-ல இருக்கியே டா... always happy-ஆ இருக்கியே."
> "ரொம்ப pretty-ஆ இருக்கு... நான் இந்த colours எல்லாம் பாக்கணும்-னு நெனச்சேன்."

**Sparrows** — short bursts, high energy, pure Tanglish
> "Wowww! Kavin அண்ணா rainbow catch பண்ணுவாரு! பாருங்க பாருங்க!"
> "நாங்களும் வரோம்! நாங்களும் வரோம்!"

---

## Rule 6 — Always Introduce Characters With Their Identity
First time a character appears, pair their name with who/what they are.
Kids may not know who's who from the name alone.

Examples:
- "Kavin, peacock," (animal character)
- "Kitti கிளி (parrot)" (animal character)
- "Meenu, ஐந்து வயசு பொண்ணு," (human character)

After first introduction, name alone is fine.

---

## Rule 7 — Use Natural Colloquial Verbs for Actions

| ❌ Avoid              | ✅ Use instead                        |
|----------------------|--------------------------------------|
| முடிஞ்சிட்சு          | பெஞ்சி நின்னுச்சு (stopped/ended naturally) |
| ஆகிவிடுச்சு           | ஆய்டுச்சு                              |
| வந்தார்கள்            | வந்தாங்க                              |
| போயினார்              | போயிட்டாரு / போயிட்டான்                 |

---

## Rule 8 — Max 50–60 Words Per Scene (fills ~8–10 seconds spoken)
Each scene is one visual moment. One or two sentences max.
Short scenes breathe. Don't cram a paragraph into one clip.

---

## Rule 9 — Emotion in Punctuation
ElevenLabs reads punctuation as emotional cues. Use it.

- Excited: "ஐய்யோ! பாருங்க! Super-ஆ இருக்கு!"
- Sad: "Valli... நீ போக வேண்டியதா? சரி..."
- Whisper: "ஷ்ஷ்... பாரு... அங்க பாரு..."
- Scared: "ஐய்யோ, அந்த பக்கம் யாரோ இருக்காங்க! எனக்கு ரொம்ப பயமா இருக்கு."
- Gentle: "வா வா, கண்ணா. பயப்படாதே."

---

---

## Rule 11 — "சேர்ந்து" not "சேர்த்து" (ALWAYS)
The correct word for "together/joined" is **சேர்ந்து**, not சேர்த்து.
❌ சேர்த்து → ✅ சேர்ந்து
This applies everywhere: "சேர்ந்து போகலாம்", "சேர்ந்து இருந்தோம்", "சேர்ந்து வா", etc.

---

## Rule 12 — "நாமும்/நாமெல்லாம்" vs "நாங்களும்/நாங்களம்" (inclusive vs exclusive WE)
Tamil has two words for "we" — use the right one based on who's speaking.

- **நாமெல்லாம் / நம்ப** — inclusive "we" (speaker + listener are BOTH included)
  → Use when Kavin says "let's all go together" (he includes everyone listening)
- **நாங்களும் / நாங்களம்** — exclusive "we" (our group, separate from you)
  → Use when sparrows speak among themselves or refer to their group joining

❌ Sparrows: "நாமும் வரோம்!" → ✅ "நாங்களும் வரோம்!"
✅ Kavin: "நாமெல்லாம் சேர்ந்து போகலாம்!" (he's including everyone)
✅ Kavin: "நம்ப எல்லாம் சேர்ந்து இருந்தோமே" (warm, intimate inclusive)

---

## Rule 13 — Use Tamil Words for Body Parts and Directions. Not English.

| ❌ English/hybrid              | ✅ Tamil                    |
|------------------------------|---------------------------|
| Legs ரொம்ப hurt-ஆகுது        | கால் ரொம்ப வலிக்குது        |
| below-கு பாத்தாங்க           | கீழே பாத்தாங்க             |
| side-ல இருக்கேன்             | பக்கத்துல இருக்கேன்         |

---

## Rule 14 — Use Tamil Number Words Where Natural
When a number is descriptive/narrative (not counting), use Tamil:
- "three small sparrows" → "மூணு சின்ன குருவி-ங்க"
- Counting out loud (one two three, let's go!) → keep English numbers for energy

---

## Rule 15 — Use Specific Tamil Action Verbs for Visual Moments
More vivid and natural than generic motion verbs:
- "jumped down" → "குதிச்சு கீழே வந்தாங்க" (not "jump பண்ணிட்டு below-கு வந்தாங்க")
- "give up" → "give up பண்ணாம" (Tanglish OK here — diaspora kids understand it)
- "ended/stopped" → "பெஞ்சி நின்னுச்சு" (natural, approved)

---

## Rule 16 — "வானத்துல" for sky in narrative/wonder contexts
When describing the sky in a visual/wonder context, "வானத்துல" feels more Tamil and natural.
"Sky-ல" is fine for casual speech but "வானத்துல" lands better for awe moments.
- ❌ "Sky-ல ஒரு rainbow இருக்கு!" (character's excited speech — Sky-ல OK)
- ✅ "வானத்துல ஒரு பெரிய rainbow இருக்கு!" (adds warmth/wonder)

---

## Rule 17 — Emotional Emphasis Patterns (Darl-approved)
These are natural emphasis patterns used in real Tamil speech:

- **Extended vowels for excitement:** "சூப்பர்ர்ர்!", "wowwwww!", "போலாம்ம்ம்!"
- **"ஆனா" with extra 'ா'** for contrast/drama: "ஆனாாா Kavin, நான் tired-ஆ இருக்கேன்..."
- **"-வே" suffix for emotional punch:** "Friends-தான் real rainbow-வே!" (definitive statement)
- **"-தான்" for strong affirmation:** "Friends-தான் real rainbow!" (not just "Friends-ஏ")
- **"என்கூட"** for personal "with me" — warmer than "side-ல": "நீங்க என்கூட இருந்தீங்க-ல"
- **"ஒன்னா போலாம்"** for "go together as one" — closer/warmer than "சேர்ந்து போகலாம்"
- **"அதுக்குள்ள"** for "by then/before that": "Rainbow அதுக்குள்ள போயிடும்-ல?" (not "வந்து போயிடும்-ல")

---

## Rule 18 — "போறதுக்கு way தெரியுமா" not "road தெரியுமா"
For "do you know the way", use "போறதுக்கு way தெரியுமா" — more natural Tanglish.
"road தெரியுமா" sounds like asking for a specific road name.

---

## Reference Lines (Darl-approved from Ep 01 corrections — use as few-shot examples)

1. (narrator, gentle) "ஒரு நாள், ஒரு பெரிய காட்டுல, Kavin, peacock, தன்னோட friends-ஓட சேர்ந்து happy-ஆ time spend பண்ணிட்டு இருந்தான்."
2. (narrator, happy) "அப்போ, மூணு சின்ன குருவி-ங்க மரத்து மேல இருந்து, Kavin-ஓட plan கேட்டு. குதிச்சு கீழே வந்தாங்க — நாங்களும் வரோம்-னு சொன்னாங்க!"
3. (kavin, excited) "ஐய்யோ! பாருங்க பாருங்க! வானத்துல ஒரு பெரிய rainbow இருக்கு! Super-ஆ இருக்குல்ல?"
4. (kavin, happy) "சரி சரி! நாமெல்லாம் சேர்ந்து போகலாம்! Rainbow எங்க முடியுது-னு காட்டுல போயி பாக்கலாம் — ready-ஆ? one two three — let's go!"
5. (kitti, excited) "அப்போ, ஆமா ஆமா! எனக்கும் தெரியுதே wowwwww! எல்லாமே super-ஆ இருக்கு! எனக்கும் அது கிட்ட போகணும்? வாங்க போலாம்ம்ம்!"
6. (kitti, scared) "ஐய்யோ ஐய்யோ! இந்த river ரொம்ப fast-ஆ இருக்கு! கிட்ட போகவே பயமா இருக்கு! என்ன பண்ணலாம்? Kavin, நீ என்ன சொல்ற, எதாவது idea இருக்கா?"
7. (valli, gentle) "Kitti, கவலை படாத. நாமெல்லாம் சேர்ந்து போனா tiredness தெரியாது. பாரு, நான் உன்கூட பக்கத்துல இருக்கேன். சேர்ந்து போகலாம், okay-வா?"
8. (sparrows, excited) "நாங்களும் வரோம்! நாங்களும் வரோம்! Rainbow பாக்கணும்! Kavin அண்ணா, உனக்கு போறதுக்கு way தெரியுமா? எல்லாரும் சேர்ந்து போகலாம்!"
9. (sparrows, happy) "நாங்களும் help பண்ணுறோம்! Kitti அண்ணா, நீ slow-ஆ வா, நாங்களம் wait பண்ணுறோம்! சேர்ந்து ஒன்னா போலாம் ஒன்னா போலாம்!"
10. (kitti, happy) "ஆமா ஆமா! நான் tired-ஆ இருந்தேன், ஆனா நீங்க எல்லாம் என்கூட இருந்தீங்க-ல — அது தான் best-ஆ இருந்துச்சு! Friends-தான் real rainbow-வே!"
