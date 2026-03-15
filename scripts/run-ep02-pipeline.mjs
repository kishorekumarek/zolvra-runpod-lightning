#!/usr/bin/env node
// run-ep02-pipeline.mjs — Bootstrap and run EP02 "Minminni" Short pipeline
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { setSetting } from '../lib/settings.mjs';
import { CostTracker } from '../lib/cost-tracker.mjs';
import { runStage3 } from '../stages/stage-03-character-prep.mjs';
import { runStage4 } from '../stages/stage-04-illustrate.mjs';
import { runStage5 } from '../stages/stage-05-animate.mjs';
import { runStage6 } from '../stages/stage-06-voice.mjs';
import { runStage7 } from '../stages/stage-07-assemble.mjs';

const sb = getSupabase();

// ─── STEP 1: Set video_type to "short" ────────────────────────────────────────
console.log('\n━━━ Step 1: Setting video_type = "short" ━━━');
await setSetting('video_type', 'short');
console.log('✅ video_type set to short');

// ─── STEP 2: Upsert characters into character_library ─────────────────────────
console.log('\n━━━ Step 2: Upserting characters to character_library ━━━');

const characters = [
  {
    name: 'Kaviya',
    description: '6-year-old Tamil girl, warm brown skin, thick black hair in two braids with red ribbon ties, wide expressive eyes, small gold stud earrings, curious and empathetic personality',
    image_prompt: 'Kaviya — 6-year-old Tamil girl, warm brown skin tone with warm golden undertones, thick black hair in two braids tied with red ribbon bows, wide expressive dark brown eyes, small gold stud earrings, wearing a dark teal pavadai-davani with gold border trim and white cotton blouse underneath, curious and empathetic personality expression, 3D cartoon animation still, Pixar-style, child-friendly, cinematic render quality, South Indian Tamil cultural clothing',
    voice_id: 'cgSgspJ2msm6clMCkdW9',
    approved: true,
  },
  {
    name: 'Arjun',
    description: '7-year-old Tamil boy, deep warm brown skin, short wavy black hair with tuft at crown, mischievous bright eyes, energetic personality, barefoot',
    image_prompt: 'Arjun — 7-year-old Tamil boy, deep warm brown skin tone with rich amber undertones, short wavy black hair with a small tuft at the crown, bright mischievous dark brown eyes, slight toothy grin, wearing a light yellow cotton short-sleeve shirt and white cotton veshti folded above the knees, barefoot, energetic personality, 3D cartoon animation still, Pixar-style, child-friendly, cinematic render quality, traditional Tamil village boy clothing',
    voice_id: 'cgSgspJ2msm6clMCkdW9',
    approved: true,
  },
  {
    name: 'Meenu',
    description: '5-year-old Tamil girl, golden-brown skin, short bob-cut black hair with pink clip, chubby cheeks, shy but cheerful personality',
    image_prompt: 'Meenu — 5-year-old Tamil girl, golden-brown skin tone with warm honey undertones, short bob-cut black hair with a bright pink hair clip on the left side, chubby cheeks, wide round dark brown eyes, shy cheerful expression, wearing a pink and orange half-saree pavadai with small white floral print and matching blouse, 3D cartoon animation still, Pixar-style, child-friendly, cinematic render quality, South Indian Tamil cultural clothing',
    voice_id: 'cgSgspJ2msm6clMCkdW9',
    approved: true,
  },
  {
    name: 'Paati',
    description: '65-year-old Tamil grandmother, warm medium-brown skin, white hair in low bun with jasmine, calm and knowing personality, no dialogue — reaction only',
    image_prompt: 'Paati — 65-year-old Tamil grandmother, warm medium-brown skin tone, white hair neatly arranged in a low bun with a white jasmine flower garland, kind calm dark brown eyes, wearing a cream and dark green cotton saree with thin red border draped Madurai-style, reading glasses on forehead, holding a steel tumbler cup, calm knowing expression, 3D cartoon animation still, Pixar-style, child-friendly, cinematic render quality, traditional Tamil grandmother attire',
    voice_id: 'no-voice', // Paati has no dialogue — reaction only
    approved: true,
  },
];

const { error: charError } = await sb
  .from('character_library')
  .upsert(characters, { onConflict: 'name' });

if (charError) {
  console.error('❌ Character upsert failed:', charError.message);
  process.exit(1);
}
console.log(`✅ ${characters.length} characters upserted: ${characters.map(c => c.name).join(', ')}`);

// ─── STEP 3: Build script object from parsed research doc ─────────────────────
console.log('\n━━━ Step 3: Building script + creating pipeline task ━━━');

const script = {
  title: 'மின்மினி — Minminni (Fireflies)',
  metadata: {
    characters: ['Kaviya', 'Arjun', 'Meenu', 'Paati'],
    moral: "You can't own something wild. True beauty is in freedom.",
    video_type: 'short',
  },
  scenes: [
    {
      scene_number: 1,
      speaker: 'Arjun',
      dialogue: 'Kaviyaa! Meenu! Vaanga, vilaiyaadalam!',
      emotion: 'joy',
      visual_description: `A wide-angle shot of a Tamil village courtyard (mutram) at dusk. Golden-orange sky with the first hints of deep purple. A large neem tree to the left. An old whitewashed wall to the right. Oil lamp glowing on the porch in the background where Paati sits. Arjun — 7-year-old Tamil boy, deep warm brown skin, short wavy black hair with a small tuft at the crown, wearing a light yellow cotton half-sleeve shirt and white veshti folded above the knees, energetic, Pixar-style — running barefoot toward camera, arms wide, laughing. Kaviya — 6-year-old Tamil girl, warm brown skin, thick black hair in two braids with red ribbon ties, wearing a dark teal pavadai-davani with gold border and white blouse, curious, Pixar-style — seen mid-distance, turning toward Arjun's voice. Meenu — 5-year-old Tamil girl, golden-brown skin, short bob-cut black hair with pink clip, wearing a pink and orange half-saree pavadai with white floral prints, shy but cheerful, Pixar-style — peeking from behind a large clay pot (kalayam) near the porch. Paati — 65-year-old Tamil grandmother, warm medium-brown skin, white hair in low bun with jasmine, cream and dark green cotton saree with red border, calm, Pixar-style — seated on the thinnai, steel cup in hand, watching with a soft smile. Lighting: Warm golden-orange dusk light from the west. Soft blue-purple in the sky east. Oil lamp on porch casts a warm amber glow on Paati's face.`,
      characters: ['Arjun', 'Kaviya', 'Meenu', 'Paati'],
      duration_seconds: 8,
    },
    {
      scene_number: 2,
      speaker: 'Arjun',
      dialogue: 'Ayo! Paaru paaru! Minminni! Minminni!',
      emotion: 'wonder',
      visual_description: `Close-up of Arjun's face, eyes huge, pointing off-screen to the right. Then cut to the first firefly — a single tiny golden light floating in the semi-dark near the neem tree. Camera pulls back to reveal 10–15 fireflies beginning to appear in the darkening yard. Arjun — same locked description — mouth open in delight, one finger pointed, body leaning forward. Kaviya — same locked description — standing beside Arjun, hand over her mouth in quiet wonder. Meenu — same locked description — toddling up behind them, eyes wide, trying to see past them. Lighting: Sky now deep blue-purple. Fireflies glow as warm gold-green pinpricks of light floating in front of the neem tree. Each firefly creates a tiny soft halo of light. Ground is mostly in shadow with dappled purple-blue ambient light.`,
      characters: ['Arjun', 'Kaviya', 'Meenu'],
      duration_seconds: 8,
    },
    {
      scene_number: 3,
      speaker: 'Kaviya',
      dialogue: 'Pidichchudunga! Naanum varen! Odunga odunga!',
      emotion: 'joy',
      visual_description: `Wide dynamic shot. All three kids running through the yard chasing fireflies. Arms outstretched, laughing. Fireflies scatter and swirl around them as they chase. The yard is now mostly dark, lit primarily by firefly glow and the distant porch lamp. Arjun — same locked description — leading the chase, leaping toward a cluster of fireflies, veshti flapping. Kaviya — same locked description — running with both hands cupped, one braid flying behind her. Meenu — same locked description — running, giggling, arms stretched wide, slightly stumbling but catching herself. Lighting: Primary light source: 20–30 fireflies creating a constellation of moving warm gold-green glow. Secondary: distant amber porch lamp. Children's faces lit softly from below by firefly light when they hold their hands near fireflies. Deep blue-purple sky.`,
      characters: ['Arjun', 'Kaviya', 'Meenu'],
      duration_seconds: 9,
    },
    {
      scene_number: 4,
      speaker: 'Arjun',
      dialogue: 'Pudinga, Pudinga! Bottle la Podunga! Paaru evvalavu iruku!',
      emotion: 'joy',
      visual_description: `Close-up of a large clear glass jar (bottle) being held by Arjun. Inside: 8–10 fireflies glowing, their light filtering through the glass making the jar pulse with warm golden light. Kaviya and Meenu crowd close, faces glowing from the jar's light. Arjun — same locked description — holding the jar aloft, grinning. Kaviya — same locked description — face close to the glass, watching the fireflies with wide eyes, one braid resting on the jar. Meenu — same locked description — standing on tiptoe to see, pressing her nose close. Lighting: The jar itself is the primary light source in this shot — a warm golden-amber lantern effect. Firefly glow reflects on all three children's warm brown faces. Background is deep blue-purple night.`,
      characters: ['Arjun', 'Kaviya', 'Meenu'],
      duration_seconds: 9,
    },
    {
      scene_number: 5,
      speaker: 'Kaviya',
      dialogue: 'Arjun... paaru. bottle la potathuku apram minmini poochiyoda velicham-la konjam konjama koraiyithu!',
      emotion: 'sadness',
      visual_description: `Same jar, same three children — but now something is different. The fireflies inside are visibly less bright. One by one they pulse weakly. The jar that was radiant now has a muted, struggling light. Kaviya's face is the focus — she's the one who notices. Her expression shifts from excitement to sadness. Kaviya — same locked description — holding the jar now (Arjun has passed it), brow furrowed, eyes going soft with worry, lips pressed together. Arjun — same locked description — behind her, looking over her shoulder, confusion on his face. Meenu — same locked description — looking up at Kaviya's face, sensing something is wrong. Lighting: The jar's glow is noticeably dimmer than scene 4 — from warm gold to a pale, struggling yellow-green. The difference in light quality tells the story even before dialogue. Children's faces are darker, lit by a weaker source.`,
      characters: ['Kaviya', 'Arjun', 'Meenu'],
      duration_seconds: 10,
    },
    {
      scene_number: 6,
      speaker: 'Kaviya',
      dialogue: 'Antha poochigaluku bottle-ulla adaipattu irukrathu pidikala. velila vitralama?',
      emotion: 'hope',
      visual_description: `Medium shot. Kaviya holds the jar to her chest and looks at Arjun with gentle, pleading eyes. Meenu watches Arjun. Beat. Arjun's mischief melts into understanding. He gives a slow nod. Kaviya's face opens into relief and hope — she begins to unscrew the jar lid. Kaviya — same locked description — holding jar against her chest, looking at Arjun, eyes earnest and a little watery. Arjun — same locked description — arms crossed at first, then dropping them as he understands, giving a solemn nod. Meenu — same locked description — head tilting, watching Arjun carefully, then smiling softly when he nods. Lighting: Dim firefly glow from the jar. Porch lamp visible in far background. This is the emotionally quietest, darkest lit scene — intentional. The release will feel like a sunrise after this.`,
      characters: ['Kaviya', 'Arjun', 'Meenu'],
      duration_seconds: 10,
    },
    {
      scene_number: 7,
      speaker: 'Kaviya',
      dialogue: 'Ponga... ponga... seekiram ponga.',
      emotion: 'awe',
      visual_description: `Slow motion moment. Kaviya tips the jar and the fireflies pour out like living sparks. They spiral upward into the dark sky, rejoining the fireflies already in the yard. The burst of light is immediate and dramatic — the yard lights up far more than when the fireflies were in the jar. Kaviya — same locked description — jar tilted, face upturned, watching fireflies rise with a soft open smile. Arjun — same locked description — beside her, head back, watching upward, arms relaxed at his sides. Meenu — same locked description — mouth open, spinning slowly in place, hands reaching up toward the rising fireflies. Lighting: This is the brightest scene in the film. 40+ fireflies creating a cascading galaxy of warm gold-green light across the entire yard. The neem tree, the clay pots, the old wall — everything is touched by firefly light. Deep blue-purple sky above makes the glow pop dramatically. Children's upturned faces glow gold from below.`,
      characters: ['Kaviya', 'Arjun', 'Meenu'],
      duration_seconds: 8,
    },
    {
      scene_number: 8,
      speaker: 'Meenu',
      dialogue: 'Paaru Kaviya akka... romba azhagaa irukku.',
      emotion: 'awe',
      visual_description: `Wide establishing shot of the entire yard. The three children stand together in the center, looking up and around. Hundreds of fireflies fill the yard — the neem tree, the air, the low bushes along the wall, all pulsing with soft gold-green light. It is overwhelmingly, quietly beautiful. Paati on the porch — a warm silhouette — smiles gently. Kaviya — same locked description — standing still, hands clasped in front of her, face turned up, smiling peacefully. Arjun — same locked description — arms hanging loose, head slowly turning to take it all in, rare stillness for him. Meenu — same locked description — leaning against Kaviya's arm, tiny and soft, looking up with huge round eyes. Paati — same locked description — on the thinnai in the background, silhouetted against the amber oil lamp, steel cup raised to lips, smiling. Lighting: Peak beauty frame of the entire short. Dense firefly constellation — warm gold-green everywhere. The clay pots cast tiny firefly-shadow patterns on the ground. The neem tree glows like a lantern tree. Sky is full deep indigo blue with one or two stars visible above the firefly layer. The oil lamp on the porch is a warm amber anchor in the background. Everything is soft, luminous, alive.`,
      characters: ['Kaviya', 'Arjun', 'Meenu', 'Paati'],
      duration_seconds: 9,
    },
  ],
};

console.log(`  Script built: "${script.title}" — ${script.scenes.length} scenes`);

// Create task ID + insert Stage 1 record
const taskId = randomUUID();
console.log(`  Task ID: ${taskId}`);

const { error: s1Error } = await sb.from('video_pipeline_runs').insert({
  task_id: taskId,
  stage: 1,
  status: 'completed',
  pipeline_state: { concept: { title: script.title, video_type: 'short' } },
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
});
if (s1Error) {
  console.error('❌ Stage 1 insert failed:', s1Error.message);
  process.exit(1);
}
console.log('  ✅ Stage 1 record inserted');

// Insert Stage 2 record with full script
const { error: s2Error } = await sb.from('video_pipeline_runs').insert({
  task_id: taskId,
  stage: 2,
  status: 'completed',
  pipeline_state: { script, scenes: script.scenes, videoType: 'short' },
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
});
if (s2Error) {
  console.error('❌ Stage 2 insert failed:', s2Error.message);
  process.exit(1);
}
console.log('  ✅ Stage 2 record inserted (script + 8 scenes)');

// Create parent NEXUS card
const { data: parentCard, error: cardError } = await sb
  .from('ops_tasks')
  .insert({
    title: '🎬 Production: Minminni (EP02 Short)',
    description: 'EP02 "Minminni" — Fireflies short. 8 scenes, 71s, 9:16. Auto-created by run-ep02-pipeline.mjs.',
    stream: 'youtube',
    status: 'in_progress',
    priority: 'high',
    task_type: 'video_production',
    auto_created: true,
    pipeline_stage: 'stage-03',
  })
  .select()
  .single();

const parentCardId = cardError ? 'ep02-minminni' : String(parentCard?.id || 'ep02-minminni');
if (cardError) {
  console.warn('  ⚠️  Could not create parent NEXUS card:', cardError.message, '— using fallback ID');
} else {
  console.log(`  ✅ Parent card created: #${parentCardId}`);
}

// ─── STEP 4: Run stages 3–7 ───────────────────────────────────────────────────
console.log('\n━━━ Step 4: Running pipeline stages 3–7 ━━━');

const tracker = new CostTracker(taskId);
let state = {
  script,
  scenes: script.scenes,
  videoType: 'short',
  parentCardId,
};

const stageFns = [
  [3, runStage3, 'Character prep'],
  [4, runStage4, 'Illustration'],
  [5, runStage5, 'Animation'],
  [6, runStage6, 'Voice'],
  [7, runStage7, 'Assemble'],
];

for (const [stageNum, stageFn, label] of stageFns) {
  console.log(`\n━━━ Stage ${stageNum}: ${label} ━━━`);

  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage: stageNum,
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onConflict: 'task_id,stage' });

  try {
    await tracker.checkBudget();
    const result = await stageFn(taskId, tracker, state);
    state = result || state;
    await tracker.flush(stageNum);

    const stateSnapshot = { ...state };
    await sb.from('video_pipeline_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        pipeline_state: stateSnapshot,
      })
      .eq('task_id', taskId)
      .eq('stage', stageNum);

    console.log(`✅ Stage ${stageNum} (${label}) complete`);
  } catch (err) {
    await sb.from('video_pipeline_runs')
      .update({
        status: 'failed',
        error: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('task_id', taskId)
      .eq('stage', stageNum);

    console.error(`\n❌ Stage ${stageNum} (${label}) FAILED: ${err.message}`);
    console.error('🛑 Pipeline halted.');
    process.exit(1);
  }
}

// ─── STEP 5: Post-process check ───────────────────────────────────────────────
console.log('\n━━━ Step 5: Post-process ━━━');
import { promises as fs } from 'fs';
const postProcessScript = '/Users/friday/.openclaw/workspace/streams/youtube/scripts/post-process-ep01.mjs';
try {
  await fs.access(postProcessScript);
  console.log('  Post-process script exists but is EP01-specific — skipping for EP02.');
} catch {
  console.log('  No post-process script found — skipping.');
}

// ─── DONE ─────────────────────────────────────────────────────────────────────
const finalOutput = state.finalVideoPath || state.assembledVideoPath || 'output/ep02-minminni-final.mp4';
const totalCost = await tracker.totalSpent();

console.log('\n🎉 EP02 pipeline complete!');
console.log(`   Output: ${finalOutput}`);
console.log(`   Total cost: $${totalCost.toFixed(4)}`);
console.log(`   Task ID: ${taskId}`);
