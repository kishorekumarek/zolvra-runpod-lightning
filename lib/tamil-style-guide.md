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
| Oru siru paravai irunthatu... | Paandi oru naal kaatula thirinju irunthaan...       |
| Kadalorattil oru...            | Sea-kittE oru...                                    |

---

## Rule 5 — Each Character Has a Distinct Voice Pattern

**Narrator** — warm, slightly poetic, colloquial Tamil with English nouns
> "Paandi kaatula thannoda friends-oda enjoy pannitu irunthaan.
>  Anniki sky-la oru big rainbow vandhuchu — romba pretty-a!"

**Paandi (curious, gentle, young male)** — Tanglish, enthusiastic but sweet
> "Ayyo, parunga! Sky paarunga — rainbow irukku! Super-a irukulla?"
> "Naan indha rainbow-a touch pannanum, aaguma?"

**Kitti (parrot, chatty, fast talker)** — rapid Tanglish, repeats things, excited
> "Aama aama! Naan paathene! Blue, red, yellow — ellame irukku irukku!"
> "Enna colour enna colour! Yaaru pottaanga theriyuma?"

**Valli (bulbul, gentle, soft female)** — slower pace, soft Tamil, caring
> "Paandi, nee vera level-a irukkiye da... always happy-a irukkiye."
> "Romba pretty-a irukku... naan indha colours ellam paakanum-nu nenachen."

**Children** — short bursts, high energy, pure Tanglish
> "Wowww! Paandi uncle rainbow catch pannuvaaru! Parunga parunga!"
> "Naamum venom! Naamum venom!"

---

## Rule 6 — Always Introduce Characters With Their Animal Type
First time a character appears, pair their name with their animal.
Kids may not know who's who from the name alone.

| Character | First mention |
|-----------|--------------|
| Paandi    | Paandi mayil (peacock) |
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

## 10 Reference Lines (approved style — use as few-shot examples in prompt)

1. (narrator, gentle) "Oru naal, Paandi kaatula thannoda friends-oda play pannitu irunthaan."
2. (narrator, warm) "Anniki sky-la oru big rainbow vandhuchu — romba pretty-a irunthuchi!"
3. (paandi, excited) "Ayyo! Parunga parunga! Rainbow irukku! Super-a irukulla?"
4. (paandi, wonder) "Naan indha rainbow-a touch pannanum... aaguma?"
5. (kitti, chatty) "Aama aama! Naan paathene! Blue, red, yellow — ellame irukku!"
6. (kitti, fast) "Enna colour enna colour! Yaaru pottaanga theriyuma theriyuma?"
7. (valli, gentle) "Paandi... romba pretty-a irukku. Naan indha colours paakanum-nu nenachen."
8. (valli, soft) "Nee vera level-a irukkiye da. Always happy-a irukkiye."
9. (children, burst) "Wowww! Paandi uncle rainbow catch pannuvaaru! Parunga!"
10. (narrator, close) "Annaiku Paandi thannoda friends-oda serthu oru super day enjoy pannaan."
