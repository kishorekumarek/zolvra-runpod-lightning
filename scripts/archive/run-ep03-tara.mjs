#!/usr/bin/env node
// EP03 Runner: Tara and the Banyan Tree
// Steps: 1b story intake → check existing state → script gen → launch stage 3+
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.mjs';
import { extractConceptFromStory } from '../stages/stage-01b-story-intake.mjs';
import { setSetting } from '../lib/settings.mjs';

const sb = getSupabase();

const STORY_TEXT = `Deep inside a forest that no map has ever fully drawn, where the air smells of wet earth and wild jasmine, there lives a world most humans have forgotten. Tall teak trees stretch toward the clouds. Parrots argue over mangoes. A stream hums the same song it has hummed for a thousand years.

At the very centre of it all stands the banyan tree. Not just any banyan — this banyan. Its trunk is so wide that six animals holding hands cannot circle it. Its aerial roots hang like ancient curtains, thick as pillars, older than memory. The forest elders say this tree was here before their grandparents' grandparents were born. The other trees lean slightly toward it, like they are always listening. Inside its roots, its hollows, its branches — this is home.

And the most frequent visitor to every corner of that home is Tara.

She is a squirrel — small even for a squirrel — with a tail twice the size it should be and eyes that are always slightly too wide, like the world keeps surprising her. This morning she is bounding through the upper branches when she spots a small mynah bird sitting frozen on a broken branch, too scared to fly back to her nest. Without waiting to be asked, she nudges her gently onto her back, climbs three branches up, and deposits her at her nest like it is the most normal thing in the world. The mynah blinks. Tara grins and races off. That is Tara. She does not wait to be asked. She just helps.

On the third hollow from the bottom of the banyan lives Mini, a mouse so tiny she can curl up inside a mango. She has organised her hollow with a precision that would impress an architect — her acorn collection sorted by size, her leaf-bed fluffed exactly four times each morning. She peeks out her door as Tara races past. "Tara, did you eat breakfast?" she calls. "No time, Mini!" And she is gone before Mini can finish her sentence. Mini sighs and tucks another acorn into its spot.

High on the banyan's tallest branch sits Albert the owl, eyes half shut, pretending to be asleep — which he never is. Albert has lived in this tree longer than anyone. He has seen three floods, two droughts, and one very confused tiger. He does not rush. He watches. And down at the roots, splashing in the stream that curls around the banyan's base, Miko the frog is doing backflips. "Miko! You're splashing mud on my door again!" Mini shouts. "Sorry sorry!" says Miko, not sorry at all, and does another backflip.

This is a normal morning at the banyan tree.

And then — everything changes.

Tara is halfway through her second lap of the upper branches when she stops. The air has gone heavy and strange, pressing down from above. The birds have gone quiet. The stream sounds louder somehow. She looks west. The sky has turned the colour of a bruise — deep purple bleeding into grey — and it is moving fast. Faster than any cloud should move. Her tail goes rigid.

The first gust hits like a wall. Leaves rip from branches in fistfuls. The canopy roars. Somewhere below, Mini shrieks. Miko goes flat against a root. Even Albert opens both eyes. The wind does not ease. It keeps coming — harder, colder — filling the whole forest with a sound like screaming. And the banyan tree, this ancient enormous thousand-year-old tree, shudders.

Tara races down to the roots. The ground is already underwater. The stream has burst its banks and the soil around the base of the tree is turning to dark sliding mud. She digs near the biggest root. It gives way too easily. The root is lifting — barely a millimetre, but lifting. The flood is getting under the foundation.

She looks up at the tree. She looks at the water rising around her feet. She looks at Mini's hollow, at Albert's branch, at Miko somewhere in the flooded roots. She takes one breath.

"Naan panren." I'll do it.

No one hears her. The storm is too loud. But she says it anyway — to herself, to the tree — and then she moves.

She reads the root system the way you read a map. This root still holds. This one has come loose. Here is where the water pours in. She traces the fault with her paws, thinking fast. Then she is off — collecting bark pieces, chunks of hardened clay from the high bank, thick wads of moss — stacking them, pressing them into the gap, using her whole body weight to pack them tight. The water pushes back. She pushes harder. It holds. For now.

She races back up through the storm. "Mini! Albert! Miko! Storm-u romba perisu — ellorum kekungal!" The storm is too big — everyone listen!

Mini is already in her doorway, clutching her acorns, eyes huge. "Tara I knew it, I said check the sky this morning—" She takes Mini's paw. "Mini. Look at me. Upper hollow. Now. Take only what fits in your paw." Mini looks at her sorted, carefully arranged acorn collection. Then she puts them all down and takes Tara's paw. Tara gets her to the upper hollow, seals the entrance with bark and moss. "Don't come out till I say. Promise me." A pause. "Promise," Mini says quietly.

Albert has not moved.

Tara lands beside him on the high branch. The wind up here is nearly impossible. "Albert mama — neengal poganum. Branch-u safe illa!" Albert turns one slow eye toward her. "I have sat through worse," the owl says, entirely calm. "They all say that." Tara is quiet for a moment. Then she sits down right next to the old owl — there in the howling storm — and says, almost gently: "Tree-ku unna vennum, Albert mama. I need you to be okay. Please."

The owl is still for a long moment. Then he ruffles his feathers, stands, and flies — heavy and dignified — to the sealed inner hollow. Without another word.

Down at the roots, Miko is already there. Not hiding. Working. Pushing mud and clay against the base with his strong back legs, packing the gaps Tara could not reach. She drops beside him. "Nee vanthutte!" Miko grins through the rain. You came. "Neeyum vanthutte," Tara grins back. So did you. They work together — frog and squirrel, side by side in the flood — without another word.

And then — CRACK.

Lightning hits a teak tree forty feet away. The shockwave shudders through the ground. The clay dam shifts. One of Tara's reinforcements collapses into the water. Everything she built there — gone in seconds. The water rushes back. The root lifts again. The whole tree groans from somewhere deep inside — a sound so low she feels it in her chest more than hears it.

Tara freezes.

One beat. Two.

Then she looks all the way up through the rain to the top of the canopy. The anchoring vine — thick, old, vital — is fraying. One side already pulled loose and whipping in the gale. If that vine goes, the tree goes.

She starts climbing.

The wind at the canopy is not wind anymore. It is a force. It shoves her sideways with every step. The bark is slick. Her paws slip twice, three times. She does not stop. She reaches the vine, grabs it, wraps it around the branch — once, twice — and ties it the way her mother showed her when she was so small she could sit in her mother's palm. The wind shoves her hard. She holds on. The vine holds. The branch holds. The tree shudders, groans, sways — and holds.

The wind drops first. Then the rain softens, slowly — from a roar to a murmur to a whisper. The first grey light of dawn finds its way through the canopy.

Tara is still up there, arms wrapped around the branch, cheek against the bark. She opens her eyes. The storm is over.

She slides down the trunk slowly, all the way to the roots, and stands at the base looking up. The banyan is battered — some branches gone, some roots exposed, mud everywhere. But standing. Rooted. Still here, the way it has been here for a thousand years. Tara places her tiny paw on the bark and says nothing.

"Tara!" Mini hits her like a small extremely soft missile. She shakes slightly but holds on very tight. Then she pulls back and inspects Tara with both paws. "You're wet. And muddy. And you have bark in your ear." "I know." "You could have been hurt." "I know." She hugs her again, tighter. Albert lands beside them. He says nothing — just gives Tara one slow, deliberate nod. Coming from Albert, that is a standing ovation.

Then Miko explodes out of the flooded roots like a green cannonball and lands directly on Tara's head. "NAMMA JEYICHOM!" We won. "Namma jeyichom namma jeyichom namma JEYICHOM!" Tara laughs — properly, for the first time since the storm began — and even Mini is smiling, and even Albert makes a sound that might, possibly, be a very small chuckle.

They sit together at the roots as the sun finally breaks through. Four of them, soaking wet and muddy and completely exhausted, watching golden light fall across everything.

The forest wakes slowly, the way it always does after a storm. First the birds — cautious, one by one. Then the rustle of other animals emerging from their shelters. The stream settles back into its banks. Flowers that folded shut in the rain open again, one petal at a time. And at the centre of it all — the banyan tree, standing exactly where it has always stood.

Tara sits at the biggest root — the one she spent all night protecting — and rests her tiny paw against the warm bark.

"Ippo theriyudha?" the narrator says softly. Do you understand now?

"Kaadai kaapathuvadu namma ellorum duty. Tara mathiri, neeyum seiyalaam. Oru sinna kaiyum, oru periya maramum kaapathum."

Protecting the forest is all of our duty. Just like Tara, you can do it too. Even the smallest hand can save the biggest tree.`;

// Voice mapping for EP03 characters
const VOICE_MAP = {
  tara: 'oDV9OTaNLmINQYHfVOXe',
  mini: '2zRM7PkgwBPiau2jvVXc',
  miko: 'Sm1seazb4gs7RSlUVw7c',
  narrator: 'XCVlHBLvc3SVXhH7pRkb',
  albert: 'JL7VCc7O6rY87Cfz9kIO',
};

const CONCEPT_CARD_ID = 255;
const EXISTING_TASK_ID = 'cb03d267-388a-48c1-8678-3ef14fbf0ceb';

async function main() {
  // ─── STEP 1: Story Intake ───
  console.log('\n━━━ STEP 1: Story Intake (Stage 1B) ━━━');
  const extracted = await extractConceptFromStory(STORY_TEXT);
  console.log('Extracted concept:', JSON.stringify(extracted, null, 2));

  // ─── STEP 2: Check existing pipeline state ───
  console.log('\n━━━ STEP 2: Check Existing Pipeline State ━━━');
  const { data: existingRuns, error: queryErr } = await sb
    .from('video_pipeline_runs')
    .select('stage_id, status, pipeline_state, completed_at')
    .eq('task_id', EXISTING_TASK_ID)
    .order('stage_id', { ascending: true });

  if (queryErr) {
    console.log('Query error (may not exist):', queryErr.message);
  }

  if (existingRuns?.length) {
    console.log('Existing runs for task', EXISTING_TASK_ID, ':');
    for (const run of existingRuns) {
      console.log(`  Stage ${run.stage_id}: ${run.status} (completed: ${run.completed_at || 'N/A'})`);
    }

    // Check if stage 2 is completed with valid script
    const stage2 = existingRuns.find(r => r.stage === 2 && r.status === 'completed');
    if (stage2?.pipeline_state?.scenes?.length === 24) {
      console.log('✅ Stage 2 already completed with 24 scenes — skipping to Stage 3');
      console.log('Will launch: node scripts/launch-pipeline.mjs', CONCEPT_CARD_ID, '3', EXISTING_TASK_ID);
      return { taskId: EXISTING_TASK_ID, skipToStage3: true };
    }
  } else {
    console.log('No existing runs found for', EXISTING_TASK_ID);
  }

  // ─── STEP 3: Generate script with new task_id ───
  console.log('\n━━━ STEP 3: Generate Script (New Task ID) ━━━');
  const taskId = randomUUID();
  console.log('New task_id:', taskId);

  // Ensure video_type is set to 'long'
  await setSetting('video_type', 'long');

  // Build concept for stage 2
  const concept = {
    title: extracted.title,
    theme: extracted.theme,
    synopsis: extracted.synopsis,
    characters: ['tara', 'mini', 'albert', 'miko'],
    outline: STORY_TEXT,
    videoType: 'long',
  };

  // Save voice mapping to pipeline_settings for stage 6
  await setSetting('voice_map', JSON.stringify(VOICE_MAP));

  // Record Stage 1 as completed
  await sb.from('video_pipeline_runs').upsert({
    task_id: taskId,
    stage_id: 'concept',
    status: 'completed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    pipeline_state: { concept },
  }, { onConflict: 'task_id,stage_id' });

  console.log('✅ Stage 1 recorded in Supabase');
  console.log('Concept:', JSON.stringify(concept, null, 2).slice(0, 500) + '...');
  console.log('\nReady to launch pipeline from stage 2 with:');
  console.log(`  node scripts/launch-pipeline.mjs ${CONCEPT_CARD_ID} 2 ${taskId}`);
  console.log('\nTask ID:', taskId);
  console.log('Concept Card ID:', CONCEPT_CARD_ID);

  return { taskId, concept, skipToStage3: false };
}

main()
  .then(result => {
    console.log('\n━━━ RESULT ━━━');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
