#!/usr/bin/env node
// seed-ep03-tiny-guardian.mjs
// Seeds the approved EP03 "The Tiny Guardian" story into the pipeline
// then launches from Stage 3 (characters already in DB, script pre-approved by Darl)
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { setSetting } from '../lib/settings.mjs';

const sb = getSupabase();
const taskId = randomUUID();

// ── Fixed IDs — reuse existing cards, never recreate ──────────────────────
const CONCEPT_CARD_ID = 255; // "Story Concept: The Tiny Guardian" — created 2026-03-18

console.log(`\n🌳 Seeding EP03: The Tiny Guardian`);
console.log(`   Task ID: ${taskId}`);
console.log(`   Concept card: ${CONCEPT_CARD_ID} (reusing existing)\n`);

// ── 1. Set video type to long-form ─────────────────────────────────────────
await setSetting('video_type', 'long');
console.log('✅ video_type = long');

const conceptCardId = CONCEPT_CARD_ID;

// ── 2. Create production parent card (or reuse if exists) ─────────────────
const { data: existingParent } = await sb.from('ops_tasks')
  .select('id')
  .eq('task_type', 'video_production')
  .like('title', '%Tiny Guardian%')
  .order('id', { ascending: false })
  .limit(1)
  .single();

let parentCardId;
if (existingParent) {
  parentCardId = existingParent.id;
  console.log(`✅ Parent card: ${parentCardId} (reusing existing)`);
} else {
  const { data: parent } = await sb.from('ops_tasks').insert({
    title: '🎬 Production: The Tiny Guardian',
    description: 'Full video production pipeline — EP03 long-form. Pre-approved by Darl 2026-03-18.',
    stream: 'youtube',
    status: 'in_progress',
    priority: 'high',
    task_type: 'video_production',
    auto_created: true,
    pipeline_stage: 'stage-03',
  }).select('id').single();
  parentCardId = parent?.id;
  console.log(`✅ Parent card: ${parentCardId} (created)`);
}

// ── 4. Build approved 24-scene script ─────────────────────────────────────
const scenes = [
  {
    scene_number: 1,
    speaker: 'narrator',
    emotion: 'gentle',
    text: 'ஒரு காடு இருந்துச்சு — பெரிய, beautiful-ஆன, ancient காடு. தேக்கு மரங்கள் மேல போய்ண்டே இருந்துச்சு, கிளி பாடிச்சு, ஆத்து தண்ணி ஓடிண்டே இருந்துச்சு.',
    visual_description: 'Wide aerial shot of ancient Tamil forest at golden hour, towering teak trees, colorful parrots in branches, winding river below, warm amber sunlight filtering through dense green canopy, lush undergrowth, 16:9',
  },
  {
    scene_number: 2,
    speaker: 'narrator',
    emotion: 'gentle',
    text: 'அந்த காட்டோட நடுவுல ஒரு மரம் இருந்துச்சு — thousand year-ஆன banyan. இதோட roots-உ தடிப்பா நின்னுச்சு, ஒரு ancient king மாதிரி. காட்டுல எல்லாரும் இதை பாத்து குனிஞ்சு கேட்டுண்டே இருந்தாங்க.',
    visual_description: 'Slow cinematic push through forest canopy revealing enormous ancient banyan tree at centre, massive aerial roots hanging like curtains, trunk too wide to encircle, golden light, 16:9',
  },
  {
    scene_number: 3,
    speaker: 'narrator',
    emotion: 'gentle',
    text: 'இது just ஒரு மரம் இல்ல — இது ஒரு வீடு. Every hollow-ல ஒரு family, every root-ல ஒரு கதை. இது காட்டோட heartbeat.',
    visual_description: 'Close-up of banyan tree hollows, small warm wooden doors shaped by bark and time, cozy interiors with tiny furniture visible, morning light filtering through aerial roots, animals peeking out, 16:9',
  },
  {
    scene_number: 4,
    speaker: 'tara',
    emotion: 'happy',
    text: 'Tara-வோட tail பெரிய, eyes-உ always wide — ஐயோ! ஒரு mynah bird branch-ல பயந்து நின்னுச்சு. Don\'t worry, I got you! Ready-ஆ? வாங்க!',
    visual_description: 'Tara the young female squirrel with reddish-brown fur, oversized bushy tail, wide warm brown eyes, cheerfully nudging a tiny mynah bird onto her back on a mossy branch, Tamil forest background, warm light, 16:9',
  },
  {
    scene_number: 5,
    speaker: 'mini',
    emotion: 'gentle',
    text: 'Mini-கிட்ட everything system-ல இருந்துச்சு — acorns sorted by size, leaf-bed exactly four times fluffy. Tara! Did you eat breakfast today? Tara!',
    visual_description: 'Mini the tiny female grey mouse with huge round worried eyes, pink ears, leaf apron, standing at door of cozy tree hollow, acorn collection neatly arranged on shelves behind her, morning forest light, 16:9',
  },
  {
    scene_number: 6,
    speaker: 'miko',
    emotion: 'excited',
    text: 'Albert uncle highest branch-ல இருந்தாங்க — eyes half-shut, total calm. கீழே? Miko backflip பண்ணிட்டு தலைக்கு தலை தண்ணியில தோவராங்க! Sorry sorry!',
    visual_description: 'Split scene: Albert the elder owl with dignified brown-white feathers perched high on banyan branch eyes half-closed, below Miko the bright green frog doing backflips in a forest stream splashing water near tree roots, 16:9',
  },
  {
    scene_number: 7,
    speaker: 'narrator',
    emotion: 'normal',
    text: 'அப்புறம் — எல்லாம் மாறிச்சு. காத்து heavy-ஆ, strange-ஆ ஆச்சு. கிளிகள் silent-ஆ போய்ண்டாங்க. Tara west-ல பாத்தாங்க — sky bruised purple-ஆ மாறிச்சு, fast-ஆ வருது.',
    visual_description: 'Tara the reddish-brown squirrel frozen mid-branch, ears pricked upright, staring west at sky turning deep bruised purple-grey, birds going silent on branches, forest stilling, ominous atmosphere shift, 16:9',
  },
  {
    scene_number: 8,
    speaker: 'narrator',
    emotion: 'scared',
    text: 'First gust — wall மாதிரி அடிச்சிச்சு! Leaves ripped, canopy roared. Mini ஐயோன்னு சொல்லிட்டு ஓடி போய்ண்டாங்க. Even Albert-வோட eyes-உ ரெண்டும் திறந்துச்சு. Banyan மரம்... ஆடிஞ்சு.',
    visual_description: 'Massive wind gust hitting the banyan tree, leaves ripping off in fistfuls, canopy bending violently, Mini the grey mouse shrieking at hollow doorway, Albert the owl eyes snapping wide open, storm darkening sky, 16:9',
  },
  {
    scene_number: 9,
    speaker: 'tara',
    emotion: 'scared',
    text: 'Ground underwater! Soil dark mud-ஆ மாறிச்சு. Tara biggest root-ல தொண்டியாங்க — root lifting-ஆ இருக்கு! Oh no... oh no no no. Flood root-ஓட underneath-ல போகுது!',
    visual_description: 'Tara the squirrel crouching at flooded banyan tree base, water rising around her paws, digging at massive root in dark sliding mud, horrified expression, root visibly lifting from waterlogged soil, storm rain, 16:9',
  },
  {
    scene_number: 10,
    speaker: 'tara',
    emotion: 'excited',
    text: 'Tara Mini hollow-ல, Albert branch-ல, Miko roots-ல — எல்லாரையும் பாத்தாங்க. ஒரு breath. நான் பண்றேன். அப்புறம் ஓடி போய்ண்டாங்க — no more waiting!',
    visual_description: 'Tight close-up on Tara the squirrel face, wide eyes steady with determination, jaw set, one deep breath, then launching into motion against the stormy dark background, rain streaming down, 16:9',
  },
  {
    scene_number: 11,
    speaker: 'tara',
    emotion: 'normal',
    text: 'Roots map மாதிரி படிச்சாங்க. இந்த root holding, இதுனு loose, இங்க தான் water வருது. Okay — dam first, then hollow seal, then the vine. Can do!',
    visual_description: 'Tara the squirrel crouching low at root system, pressing and testing each root methodically with her paws in rising floodwater, focused problem-solving expression, rain-dark forest background, 16:9',
  },
  {
    scene_number: 12,
    speaker: 'tara',
    emotion: 'excited',
    text: 'Bark pieces, clay, thick moss — collect பண்ணிட்டு gap-ல pack பண்ணுச்சு, full body weight போட்டு. Water pushed back. கொஞ்சம் நேரம் இருக்கு — just hold it, hold it!',
    visual_description: 'Tara the squirrel in blur of motion collecting bark chunks and clay, packing them into root gap with her whole body weight against rushing floodwater, determined fierce expression, heavy rain, 16:9',
  },
  {
    scene_number: 13,
    speaker: 'tara',
    emotion: 'scared',
    text: 'Branch-ல ஓடி போய்ண்டாங்க — soaking wet, barely holding. MINI! ALBERT! MIKO! Storm-உ ரொம்ப பெரிசு! எல்லோரும் கேங்க! Storm ரொம்ப பெரிசு டா!',
    visual_description: 'Tara the squirrel racing through storm-lashed branches, soaking wet, screaming into howling wind and rain, branches whipping around her, desperate urgent expression, dark stormy canopy, 16:9',
  },
  {
    scene_number: 14,
    speaker: 'mini',
    emotion: 'scared',
    text: 'Mini doorway-ல நின்னு இருந்துச்சு, acorns-உ clutching. Tara I knew it! Tara — Mini கை பிடிச்சாங்க. Upper hollow, now. Only what fits in your paw. Promise me.',
    visual_description: 'Mini the tiny grey mouse at hollow doorway clutching acorn collection, wide frightened eyes, Tara the squirrel gently taking her paw leading her upward through stormy tree, rain visible outside, 16:9',
  },
  {
    scene_number: 15,
    speaker: 'albert',
    emotion: 'normal',
    text: 'Albert uncle — ஒரு movement-எ இல்ல. Tara: போகணும்! Albert: I have sat through worse. Tara softly: Tree-க்கு உன்ன வேணும், Albert uncle. Please. Albert flew.',
    visual_description: 'Tara the squirrel sitting quietly beside Albert the dignified elder owl on storm-tossed high branch, gentle pleading expression, Albert with eyes softening, then spreading wings and flying to inner hollow, 16:9',
  },
  {
    scene_number: 16,
    speaker: 'miko',
    emotion: 'excited',
    text: 'Miko roots-ல already இருந்தாங்க — hiding-எ இல்ல, working! Tara jumped down. நீ வந்துட்டே! Miko grins: நீயும் வந்துட்டே! கூட்டா work பண்ணாங்க — no words needed!',
    visual_description: 'Miko the bright green frog pushing clay and mud against banyan roots with strong back legs, Tara the squirrel landing beside Miko, both grinning at each other, working side by side in rising floodwater, 16:9',
  },
  {
    scene_number: 17,
    speaker: 'narrator',
    emotion: 'scared',
    text: 'CRACK. Lightning — forty feet away. Shockwave ground-உ துணிச்சிச்சு. Dam gone — water rushed back. Root lifted. Banyan deep-ல இருந்து groan பண்ணிச்சு. Tara froze.',
    visual_description: 'Lightning striking teak tree nearby, massive shockwave effect, Tara the squirrel frozen in shock as clay dam collapses and floodwater surges back, banyan tree groaning and swaying, dark stormy chaos, 16:9',
  },
  {
    scene_number: 18,
    speaker: 'tara',
    emotion: 'excited',
    text: 'Anchoring vine fraying — last chance! Wind like a wall. Paws slipping, bark slick. Reached it! Twice wrapped, tight tied. நான் விடலா! Wind pushed — she held!',
    visual_description: 'Tara the squirrel climbing canopy in brutal storm wind, tiny paws gripping slick bark, reaching fraying anchoring vine at treetop, wrapping it desperately with shaking paws against howling gale, fierce determined expression, 16:9',
  },
  {
    scene_number: 19,
    speaker: 'narrator',
    emotion: 'gentle',
    text: 'காத்து நின்னிச்சு. மழை — கொஞ்சம் கொஞ்சமா — whisper-ஆ மாறிச்சு. First light, dawn. Tara branch-ல இருந்தாங்க, eyes closed. She opened them. It was over.',
    visual_description: 'Wind dropping, rain softening to gentle drizzle, first pale pink dawn light filtering through storm-torn canopy, Tara the squirrel still clinging to high branch with closed eyes, slowly opening them, peaceful relief, 16:9',
  },
  {
    scene_number: 20,
    speaker: 'tara',
    emotion: 'gentle',
    text: 'கொஞ்சம் கொஞ்சம் slide பண்ணிட்டு roots-க்கு வந்தாங்க. பாத்தாங்க — battered, some branches gone, mud everywhere. But standing. Rooted. நன்றி. Thank you, பெரிய மரம்.',
    visual_description: 'Tara the squirrel sliding slowly down massive banyan trunk to roots, looking up at battered but standing ancient tree in early morning light, placing tiny paw gently on bark with grateful expression, 16:9',
  },
  {
    scene_number: 21,
    speaker: 'mini',
    emotion: 'happy',
    text: 'TARA! Mini ஓடி வந்து hug பண்ணாங்க. You\'re wet, muddy, bark-in-ear! I know. I know. Albert landed — no words — just one slow nod. That was enough.',
    visual_description: 'Mini the tiny grey mouse launching herself at Tara the squirrel in a tight hug, both emotional at banyan base, Albert the dignified elder owl landing beside them giving one slow approving nod, dawn light, 16:9',
  },
  {
    scene_number: 22,
    speaker: 'miko',
    emotion: 'excited',
    text: 'MIKO cannonball மாதிரி jump பண்ணி — right on Tara\'s head! நம்ம ஜெயிச்சோம்! We did it, we ACTUALLY did it! Everyone laughed — even Albert. Golden sunlight!',
    visual_description: 'Miko the green frog leaping joyfully onto Tara the squirrel\'s head, all four characters — Tara, Mini, Miko, Albert — together at banyan roots laughing in warm golden morning sunlight, 16:9',
  },
  {
    scene_number: 23,
    speaker: 'narrator',
    emotion: 'happy',
    text: 'காடு மெல்ல மெல்ல விழிப்படைச்சிச்சு. கிளிகள் திரும்பி வந்தாங்க. மரங்கள் stretch பண்ணுங்க. Flowers petal by petal திறந்தாங்க. Banyan மரம் — exactly where it always stood.',
    visual_description: 'Forest waking up in morning light, birds returning to branches, animals emerging from shelters, flowers opening, stream settling back into banks, ancient banyan tree standing proud at forest centre, 16:9',
  },
  {
    scene_number: 24,
    speaker: 'narrator',
    emotion: 'gentle',
    text: 'Tara-வோட paw banyan root-ல வச்சாங்க. இப்போ தெரியுதா? காட்டை காப்பாத்துவது நம்ம எல்லோரும் duty. Tara மாதிரி நீயும் செய்யலாம். ஒரு சின்ன கையும் பெரிய மரமும் காப்பாத்தும்.',
    visual_description: 'Tara the squirrel sitting alone at largest banyan root, placing tiny paw on warm sun-lit bark, looking up at the great tree with calm proud expression, warm golden morning light, forest alive behind her, 16:9',
  },
];

const script = {
  youtube_seo: {
    title: 'The Tiny Guardian: How Tara Saved the Forest\'s Oldest Tree | Tamil Kids Story',
    description: 'Tara the squirrel races against a lethal monsoon to save the ancient banyan tree and her friends. A story about courage, friendship and protecting nature — in Tamil and Tanglish for kids! #TamilKids #TinyTamilTales #KidsStory',
    tags: ['tamil story', 'tamil kids', 'tamil cartoon', 'tiny tamil tales', 'kids story', 'nature story', 'squirrel story', 'banyan tree', 'tamil animation', 'moral story for kids'],
  },
  metadata: {
    title: 'The Tiny Guardian',
    characters: ['Tara', 'Mini', 'Albert', 'Miko'],
    theme: 'protecting nature',
    targetDurationSeconds: 240,
    targetAge: '3-7',
    videoType: 'long',
    episodeNumber: 3,
    approvedByDarl: '2026-03-18',
  },
  scenes,
};

// ── 5. Seed Stage 1 (concept) as completed ────────────────────────────────
await sb.from('video_pipeline_runs').upsert({
  task_id: taskId,
  stage_id: 'concept',
  status: 'completed',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  pipeline_state: { concept: script.metadata, parentCardId },
}, { onConflict: 'task_id,stage_id' });

// ── 6. Seed Stage 2 (script) as completed ─────────────────────────────────
await sb.from('video_pipeline_runs').upsert({
  task_id: taskId,
  stage_id: 'script',
  status: 'completed',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  pipeline_state: {
    script,
    scenes,
    concept: script.metadata,
    parentCardId,
    videoType: 'long',
  },
}, { onConflict: 'task_id,stage_id' });

console.log(`✅ Stage 1 + 2 seeded (script: ${scenes.length} scenes)`);
console.log(`\n🚀 Ready to launch from Stage 3`);
console.log(`   node scripts/launch-pipeline.mjs ${conceptCardId} 3 ${taskId}\n`);

// Print the task ID for reference
console.log(`TASK_ID=${taskId}`);
console.log(`CONCEPT_ID=${conceptCardId}`);
