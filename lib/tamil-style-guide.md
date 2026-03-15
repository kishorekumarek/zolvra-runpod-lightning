# Tamil Script Style Guide — Tiny Tamil Tales
## For Claude (Stage 2 script generation)

---

## The Voice
Tamil diaspora kids in UAE, UK, US, Canada, Australia.
They speak Tamil at home but think in English.
The script must sound like their Tamil parent telling a bedtime story — warm, natural, fun.
NOT a school textbook. NOT a literature class. NOT a newsreader.

---

## Rule 1 — Romanized Only. No Tamil Script.
Every single word must be written in English letters.
Never use Tamil Unicode characters (அ ஆ இ etc.) — ElevenLabs TTS reads romanized Tamil better,
and diaspora kids read romanized naturally.

❌ Wrong: "தன்னோட friends-கிட்ட ஓடி வந்துச்சு"
✅ Right:  "thannoda friends-kita odi vanthuchi"

---

## Rule 2 — Avoid ழ (zha) Words. Use Tanglish Instead.
The Tamil ழ sound is unique and most TTS models mispronounce it.
When a word has ழ, replace it with an English word or a simpler Tamil word.

| ❌ Avoid (has ழ)        | ✅ Use instead            |
|------------------------|--------------------------|
| mazhai (rain)          | rain                     |
| vazhi (way/path)       | road, way                |
| ezhil / azhaga (beautiful) | pretty-a, beautiful-a |
| thaazh (low/below)     | keezhE, below            |
| pazhagu (practice/get used to) | practicE pannu    |
| ezhunthaan (got up)    | veliye vanthaan, stand up pannaan |
| vizhaa (festival/fall) | festival, keezhE vizhunthaan |

---

## Rule 3 — Colloquial Contractions Only. No Formal Grammar.

| ❌ Formal (textbook)    | ✅ Colloquial (how people talk) |
|------------------------|--------------------------------|
| irukku illaa?          | irukulla?                      |
| sollugiRen             | solluven / solluRen            |
| vandhaargal            | vanthaanga                     |
| pOgiRaan               | pORAan / poran                 |
| paarkiRaan             | paakuRAan / paakuRaan          |
| seikiRaan              | panRaan / pannuRaan            |
| enna seivOm?           | enna pannalaam?                |
| vandhaai               | vanthiya / vanthe              |

---

## Rule 4 — No Literary Story Openings.
Avoid formal once-upon-a-time phrases. Start warm and direct.

| ❌ Avoid                        | ✅ Use instead                                      |
|--------------------------------|-----------------------------------------------------|
| Oru mazhai naal...             | Oru naal, kaatula rain penjitu irunthuchi...        |
| Oru siru paravai irunthatu... | Kavin oru naal kaatula thirinju irunthaan...       |
| Kadalorattil oru...            | Sea-kittE oru...                                    |

---

## Rule 5 — Each Character Has a Distinct Voice Pattern

**Narrator** — warm, slightly poetic, colloquial Tamil with English nouns
> "Kavin kaatula thannoda friends-oda enjoy pannitu irunthaan.
>  Anniki sky-la oru big rainbow vandhuchu — romba pretty-a!"

**Kavin (curious, gentle, young male)** — Tanglish, enthusiastic but sweet
> "Ayyo, parunga! Sky paarunga — rainbow irukku! Super-a irukulla?"
> "Naan indha rainbow-a touch pannanum, aaguma?"

**Kitti (parrot, chatty, fast talker)** — rapid Tanglish, repeats things, excited
> "Aama aama! Naan paathene! Blue, red, yellow — ellame irukku irukku!"
> "Enna colour enna colour! Yaaru pottaanga theriyuma?"

**Valli (bulbul, gentle, soft female)** — slower pace, soft Tamil, caring
> "Kavin, nee vera level-a irukkiye da... always happy-a irukkiye."
> "Romba pretty-a irukku... naan indha colours ellam paakanum-nu nenachen."

**Children** — short bursts, high energy, pure Tanglish
> "Wowww! Kavin uncle rainbow catch pannuvaaru! Parunga parunga!"
> "Naamum venom! Naamum venom!"

---

## Rule 6 — Always Introduce Characters With Their Animal Type
First time a character appears, pair their name with their animal.
Kids may not know who's who from the name alone.

| Character | First mention |
|-----------|--------------|
| Kavin    | Kavin, peacock, |
| Kitti     | Kitti kili (parrot) |
| Valli     | Valli kuruvi (bulbul) |

After first introduction, name alone is fine.

---

## Rule 7 — Use Natural Colloquial Verbs for Actions

| ❌ Avoid           | ✅ Use instead        |
|-------------------|----------------------|
| mudinchitchu      | penji ninnuchi (stopped/ended naturally) |
| aagividuchu       | aayduchu             |
| vandhaargal       | vanthaanga           |
| pOyinaar          | poyitaaru / poyitaan |

---

## Rule 8 — Max 50–60 Romanized Words Per Scene (fills ~8–10 seconds spoken)
Each scene is one visual moment. One or two sentences max.
Short scenes breathe. Don't cram a paragraph into one clip.

---

## Rule 9 — Emotion in Punctuation
ElevenLabs reads punctuation as emotional cues. Use it.

- Excited: "Ayyo! Parunga! Super-a irukku!"
- Sad: "Valli... nee poga vendiyadha? Seri..."
- Whisper: "Shh... paaru... anga paaru..."
- Scared: "Enna idhu? Enna idhu? Naanum... bayama irukku..."
- Gentle: "Vaa vaa, kanna. Bayapadathe."

---

---

## Rule 11 — "sernthu" not "serthu" (ALWAYS)
The correct romanization for "together/joined" is **sernthu**, not serthu.
❌ serthu → ✅ sernthu
This applies everywhere: "sernthu pogalaam", "sernthu irunthom", "sernthu vaa", etc.

---

## Rule 12 — "Naamum/Naamellam" vs "Naangalum/Naangalam" (inclusive vs exclusive WE)
Tamil has two words for "we" — use the right one based on who's speaking.

- **Naamellam / namba** — inclusive "we" (speaker + listener are BOTH included)
  → Use when Kavin says "let's all go together" (he includes everyone listening)
- **Naangalum / naangalam** — exclusive "we" (our group, separate from you)
  → Use when sparrows speak among themselves or refer to their group joining

❌ Sparrows: "Naamum varom!" → ✅ "Naangalum varom!"
✅ Kavin: "Naamellam sernthu pogalaam!" (he's including everyone)
✅ Kavin: "namba ellam sernthu irundhome" (warm, intimate inclusive)

---

## Rule 13 — Use Tamil Words for Body Parts and Directions. Not English.

| ❌ English/hybrid         | ✅ Tamil                   |
|--------------------------|---------------------------|
| Legs romba hurt-aaguthu  | Kaal romba Valikuthu      |
| below-ku paathaanga      | keela paathaanga          |
| side-la irukken          | pakkathu-la irukken       |

---

## Rule 14 — Use Tamil Number Words Where Natural
When a number is descriptive/narrative (not counting), use Tamil:
- "three small sparrows" → "moonu chinna kuruvi-nga"
- Counting out loud (one two three, let's go!) → keep English numbers for energy

---

## Rule 15 — Use Specific Tamil Action Verbs for Visual Moments
More vivid and natural than generic motion verbs:
- "jumped down" → "kudhichu keela vanthaanga" (not "jump pannittu below-ku vanthaanga")
- "give up" → "give up pannama" (Tanglish OK here — diaspora kids understand it)
- "ended/stopped" → "penji ninnuchi" (natural, approved)

---

## Rule 16 — "vaanathula" for sky in narrative/wonder contexts
When describing the sky in a visual/wonder context, "vaanathula" feels more Tamil and natural.
"Sky-la" is fine for casual speech but "vaanathula" lands better for awe moments.
- ❌ "Sky-la oru rainbow irukku!" (character's excited speech — Sky-la OK)
- ✅ "vaanathula oru peria rainbow irukku!" (adds warmth/wonder)

---

## Rule 17 — Emotional Emphasis Patterns (Darl-approved)
These are natural emphasis patterns used in real Tamil speech:

- **Extended vowels for excitement:** "super-aaaaaa!", "wowwwww!", "polammmm!"
- **"Aanaa" with extra 'a'** for contrast/drama: "Aanaa Kavin, naan tired-aa irukken..."
- **"-vey" suffix for emotional punch:** "Friends-dhan real rainbow-vey!" (definitive statement)
- **"-dhan" for strong affirmation:** "Friends-dhan real rainbow!" (not just "Friends-ae")
- **"enkuda"** for personal "with me" — warmer than "side-la": "neenga enkuda iruntheenga"
- **"onnaa polam"** for "go together as one" — closer/warmer than "serthu pogalaam"
- **"adhukulla"** for "by then/before that": "Rainbow adhukulla poayidum-la?" (not "vandhu poayidum-la")

---

## Rule 18 — "pograthuku way theriyuma" not "road theriyuma"
For "do you know the way", use "pograthuku way theriyuma" — more natural Tanglish.
"road theriyuma" sounds like asking for a specific road name.

---

## Reference Lines (Darl-approved from Ep 01 corrections — use as few-shot examples)

1. (narrator, gentle) "Oru naal, oru peria kaatula, Kavin, peacock, thannoda friends-oda sernthu happy-a time spend pannitu irunthaan."
2. (narrator, happy) "Appo, moonu chinna kuruvi-nga marathu mela irunthu, Kavin-oda plan ketu. kudhichu keela vanthaanga — naangalum varom-nu sonaanga!"
3. (kavin, excited) "Ayyo! Paarunga paarunga! vaanathula oru peria rainbow irukku! Super-a irukulla?"
4. (kavin, happy) "Seri seri! Naamellam sernthu pogalaam! Rainbow enga mudiyuthu-nu kaatula poyi paakkalaam — ready-aa? one two three — let's go!"
5. (kitti, excited) "Apo, Aama aama! Enakum theriyuthe wowwwww! ellame super-ah irukku! enakum adhu kitta poganum? Vanga polammmm!"
6. (kitti, scared) "Ayyo ayyo! Indha river romba fast-a irukku! Kitta poga-ve bayama irukku! Enna pannalaam? Kavin, nee enna solra, ethavadhu idea iruka?"
7. (valli, gentle) "Kitti, kavalai padaatha. Naamellam sernthu ponaa tiredness theriyaathu. Paaru, naan unkooda pakkathu-la irukken. Sernthu pogalaam, okay-va?"
8. (sparrows, excited) "Naangalum varom! naangalum varom! Rainbow paakanum! Kavin anna, unaku pograthuku way theriyuma? ellarum sernthu pogalaam!"
9. (sparrows, happy) "Naangalum help pannurom! Kitti anna, nee slow-a vaa, naangalam wait pannurom! Sernthu onnaa polam onnaa polaam!"
10. (kitti, happy) "Aama aama! Naan tired-aa irunthen, aana neenga ellam enkuda iruntheenga-la — adhu thaan best-aa irunthuchi! Friends-dhan real rainbow-vey!"
