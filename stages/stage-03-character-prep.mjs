// stages/stage-03-character-prep.mjs — Resolve characters from library + generate reference images
// Auto-creates missing characters via Claude + Telegram approval (diff-style on rejection).
// Existing characters can be customized per-episode without mutating the library.
// Reference images require Telegram approval before caching.
import 'dotenv/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getSupabase } from '../lib/supabase.mjs';
import {
  sendTelegramMessage, sendApprovalBotMedia,
  sendTelegramMessageWithButtons, waitForTelegramResponse,
  sendTelegramMessageWithCustomButtons, waitForTelegramMultiResponse,
} from '../lib/telegram.mjs';
import { generateSceneImage } from '../lib/image-gen.mjs';
import { uploadCharacterImage, uploadEpisodeCharacterImage, uploadToStorage, downloadFromStorage, BUCKETS } from '../lib/storage.mjs';
import { callClaude } from '../../shared/claude.mjs';
import { pickVoiceFromPool } from '../lib/voice-config.mjs';

const STAGE = 3;
const MAX_REJECT_CYCLES = 3;
const MAX_IMAGE_CYCLES = 3;

/**
 * Build a diff-style Telegram message comparing old and new character proposals.
 */
function buildDiffMessage(name, oldProposal, newProposal) {
  const fields = ['description', 'image_prompt'];
  const changed = new Set(newProposal.changed_fields || []);
  const lines = [`👤 Updated Character Proposal: ${name}\n`];
  for (const field of fields) {
    if (changed.has(field)) {
      lines.push(`${field}: "${oldProposal[field]}" → "${newProposal[field]}"`);
    } else {
      lines.push(`${field}: unchanged ✓`);
    }
  }
  return lines.join('\n');
}

/**
 * Use Claude to refine an image prompt based on reviewer feedback.
 * Returns the refined prompt, or the original if refinement fails.
 */
async function refineImagePrompt(currentPrompt, feedback) {
  try {
    const msg = await callClaude({
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      system: 'You are an image prompt editor. Given a current image generation prompt and reviewer feedback, return ONLY an updated prompt string. No JSON, no explanation, just the prompt text.',
      messages: [{
        role: 'user',
        content: `Current prompt: "${currentPrompt}"\n\nReviewer feedback: "${feedback}"\n\nReturn the updated prompt.`,
      }],
    });
    return msg.content[0]?.text?.trim() || currentPrompt;
  } catch (err) {
    console.warn(`  ⚠️  Prompt refinement failed: ${err.message} — reusing previous prompt`);
    return currentPrompt;
  }
}

/**
 * Classify a character into a voice type based on their description.
 * Returns: 'kid' | 'elder_male' | 'elder_female' | 'narrator'
 */
async function classifyCharacterType(name, description) {
  try {
    const msg = await callClaude({
      model: 'claude-sonnet-4-6',
      maxTokens: 32,
      system: `Classify this character into exactly one voice type. Return ONLY one of these words: kid, elder_male, elder_female

Rules:
- "kid" = children (under 25), young animals, small creatures, babies, any boy or girl character
- "elder_male" = adult/old male humans or male animals above age 25
- "elder_female" = adult/old female humans or female animals above age 25

Return ONLY the single word. No explanation.`,
      messages: [{
        role: 'user',
        content: `Character: ${name}\nDescription: ${description}`,
      }],
    });
    const type = msg.content[0]?.text?.trim().toLowerCase();
    if (['kid', 'elder_male', 'elder_female'].includes(type)) return type;
    return 'kid'; // default for children's channel
  } catch {
    return 'kid';
  }
}

/**
 * Stage 3: Resolve all characters from library.
 *
 * Flow:
 *   A. Resolve characters from library
 *   B. Review existing characters (approve / customize / reject)
 *   C. Generate missing characters via Claude (diff-style approval)
 *   D. Generate reference images for characters that still need them (feedback-aware)
 *   E. Post roster summary + return state
 */
export async function runStage3(taskId, tracker, state = {}) {
  console.log('👤 Stage 3: Character preparation...');

  const { script } = state;
  if (!script) throw new Error('Stage 3: script not found in pipeline state');

  const characterNames = script.metadata?.characters || [];
  const supabase = getSupabase();
  const artStyle = state.artStyle || '3D Pixar animation still';
  const charTmpDir = `/tmp/${taskId}/characters`;
  // Track assigned voice IDs to avoid giving the same voice to multiple characters
  const usedVoiceIds = new Set();
  await fs.mkdir(charTmpDir, { recursive: true });

  // ── A. Resolve each character from the library ──────────────────────
  const characterMap = {};
  const missingCharacters = [];

  for (const name of characterNames) {
    const { data: chars, error } = await supabase
      .from('character_library')
      .select('*')
      .ilike('name', name)
      .eq('approved', true);

    if (error) throw new Error(`Character lookup failed for ${name}: ${error.message}`);

    if (!chars || chars.length === 0) {
      missingCharacters.push(name);
    } else {
      characterMap[name] = chars[0];
    }
  }

  // ── B. Review existing characters (approve / customize / reject) ────
  const episodeOverrides = state.episodeOverrides || {};

  for (const [name, character] of Object.entries(characterMap)) {
    const charId = character.id;
    const charVersion = character.version || 1;

    // Try to load and show existing cached reference image
    let existingRefPath = null;
    try {
      const storagePath = `${charId}/v${charVersion}.png`;
      const cached = await downloadFromStorage({ bucket: BUCKETS.characters, path: storagePath });
      existingRefPath = join(charTmpDir, `${name.toLowerCase()}_existing.png`);
      await fs.writeFile(existingRefPath, cached);
      await sendApprovalBotMedia({
        filePath: existingRefPath,
        type: 'photo',
        caption: `Existing character: ${name}`,
      });
    } catch {
      // No cached image — text only
    }

    const reviewMsg = [
      `👤 Existing Character: ${name}`,
      ``,
      `Description: ${character.description}`,
      `Image Prompt: ${character.image_prompt}`,
    ].join('\n');

    const callbackPrefix = `s3_exist_${name}`;
    const msgId = await sendTelegramMessageWithCustomButtons(reviewMsg, callbackPrefix, [
      { text: '✅ Approve', action: 'approve' },
      { text: '✏️ Customize', action: 'customize' },
      { text: '❌ Reject', action: 'reject' },
    ]);

    const decision = await waitForTelegramMultiResponse(msgId, callbackPrefix, {
      needsFeedback: ['reject', 'customize'],
    });

    if (decision.action === 'approve') {
      // Load cached reference image buffer if we had it
      if (existingRefPath) {
        try {
          character.referenceImageBuffer = await fs.readFile(existingRefPath);
        } catch { /* non-critical */ }
      }
      if (character.voice_id && character.voice_id !== 'PLACEHOLDER') {
        usedVoiceIds.add(character.voice_id);
      }
      console.log(`  ✓ ${name}: approved as-is`);
      continue;
    }

    if (decision.action === 'reject') {
      console.warn(`  ✗ ${name}: rejected — removing from episode`);
      delete characterMap[name];
      continue;
    }

    // ── Customize flow ──
    const tweakText = decision.comment;
    if (!tweakText) {
      console.log(`  ✏️ ${name}: customize selected but no tweak text — using as-is`);
      continue;
    }

    console.log(`  ✏️ ${name}: customizing for this episode — "${tweakText}"`);
    let episodePrompt = `${character.image_prompt}. Episode-specific: ${tweakText}`;
    let epImageApproved = false;

    for (let epCycle = 0; epCycle < MAX_IMAGE_CYCLES; epCycle++) {
      const fullPrompt = `${episodePrompt}, full body, plain white background, reference sheet, ${artStyle}, child-friendly`;
      const buffer = await generateSceneImage({
        prompt: fullPrompt,
        sceneNumber: 0,
        aspectRatio: '1:1',
      });

      const epRefPath = join(charTmpDir, `${name.toLowerCase()}_ep.png`);
      await fs.writeFile(epRefPath, buffer);

      await sendApprovalBotMedia({
        filePath: epRefPath,
        type: 'photo',
        caption: `✏️ Episode reference: ${name} (attempt ${epCycle + 1})\nTweak: ${tweakText}`,
      });

      const epCallbackPrefix = `s3_epimg_${name}_${epCycle}`;
      const epMsgId = await sendTelegramMessageWithButtons(
        `Approve episode reference image for ${name}?`,
        epCallbackPrefix,
      );
      const epDecision = await waitForTelegramResponse(epMsgId, epCallbackPrefix);

      if (epDecision.approved) {
        character.referenceImageBuffer = buffer;
        character.episodeImagePrompt = episodePrompt;
        try {
          await uploadEpisodeCharacterImage({ characterId: charId, taskId, buffer });
          console.log(`  ✓ ${name}: episode reference approved + cached (ep_${taskId})`);
        } catch (uploadErr) {
          console.warn(`  ⚠️  ${name}: episode image approved but upload failed: ${uploadErr.message}`);
        }
        episodeOverrides[name] = {
          tweakText,
          episodeImagePrompt: episodePrompt,
          storagePath: `${charId}/ep_${taskId}.png`,
        };
        epImageApproved = true;
        break;
      }

      // Rejected — refine prompt via Claude
      console.log(`  ✗ ${name} episode image rejected (cycle ${epCycle + 1}/${MAX_IMAGE_CYCLES}): ${epDecision.comment}`);
      if (epDecision.comment) {
        episodePrompt = await refineImagePrompt(episodePrompt, epDecision.comment);
        console.log(`  ↩️  ${name} episode prompt refined`);
      }
    }

    if (!epImageApproved) {
      console.warn(`  ⚠️  ${name}: no approved episode image — falling back to canonical`);
    }
  }

  // ── C. Generate missing characters via Claude (diff-style approval) ─
  if (missingCharacters.length > 0) {
    console.warn(`⚠️  Missing characters: ${missingCharacters.join(', ')}`);

    for (const missingName of missingCharacters) {
      const genSystemPrompt = `You are a character designer for a Tamil children's YouTube channel called @tinytamiltales.

Given a character name and story context, generate:
1. description — 1-2 sentence character description (age, gender, personality, role in story). Be specific about age — this is used for voice assignment.
2. image_prompt — detailed visual prompt for image generation (physical appearance, clothing, art style details). Be specific about face, skin tone, hair, body type.

Return ONLY a JSON object. No markdown. No explanation.
{
  "description": "...",
  "image_prompt": "..."
}`;

      const conceptContext = state.scenes
        ? state.scenes.filter(s => s.speaker?.toLowerCase() === missingName.toLowerCase()).slice(0, 3).map(s => s.visual_description).join('; ')
        : '';

      let proposal;
      const initialMsg = await callClaude({
        model: 'claude-sonnet-4-6',
        maxTokens: 512,
        system: genSystemPrompt,
        messages: [{
          role: 'user',
          content: `Character name: ${missingName}\nStory context: ${conceptContext || 'No additional context'}`,
        }],
      });

      let rawText = initialMsg.content[0]?.text?.trim() || '';
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        proposal = JSON.parse(rawText);
      } catch {
        throw new Error(`Stage 3: failed to parse initial character proposal for ${missingName}. Raw: ${rawText.slice(0, 200)}`);
      }

      let previousProposal = null;

      for (let cycle = 0; cycle <= MAX_REJECT_CYCLES; cycle++) {
        // Build approval message — diff-style on retries, full on first attempt
        let approvalMsg;
        if (previousProposal && proposal.changed_fields) {
          approvalMsg = buildDiffMessage(missingName, previousProposal, proposal);
        } else {
          approvalMsg = [
            `👤 New Character Proposal: ${missingName}`,
            ``,
            `Description: ${proposal.description}`,
            `Image Prompt: ${proposal.image_prompt}`,
          ].join('\n');
        }

        const callbackPrefix = `s3_char_${missingName}_${cycle}`;
        const msgId = await sendTelegramMessageWithButtons(approvalMsg, callbackPrefix);
        const decision = await waitForTelegramResponse(msgId, callbackPrefix);

        if (decision.approved) {
          // Strip changed_fields before inserting
          const { changed_fields, ...cleanProposal } = proposal;

          // Auto-assign voice from pool based on character description
          const charType = await classifyCharacterType(missingName, cleanProposal.description);
          const assignedVoiceId = pickVoiceFromPool(charType, usedVoiceIds);
          usedVoiceIds.add(assignedVoiceId);
          console.log(`  🎙️ ${missingName}: classified as ${charType} → voice ${assignedVoiceId.slice(0, 8)}...`);

          const { data: inserted, error: insertErr } = await supabase
            .from('character_library')
            .insert({
              name: missingName,
              description: cleanProposal.description,
              image_prompt: cleanProposal.image_prompt,
              voice_id: assignedVoiceId,
              approved: true,
            })
            .select()
            .single();

          if (insertErr) throw new Error(`Failed to insert character ${missingName}: ${insertErr.message}`);

          characterMap[missingName] = inserted;
          console.log(`  ✓ ${missingName}: created and approved`);
          break;
        }

        // Rejected — re-generate with feedback + request changed_fields
        console.log(`  ✗ ${missingName} rejected (cycle ${cycle + 1}/${MAX_REJECT_CYCLES}): ${decision.comment}`);
        if (cycle === MAX_REJECT_CYCLES) {
          throw new Error(`Stage 3: character ${missingName} rejected ${MAX_REJECT_CYCLES + 1} times — aborting`);
        }

        // Save current proposal for diff comparison
        previousProposal = { ...proposal };
        delete previousProposal.changed_fields;

        const retryMsg = await callClaude({
          model: 'claude-sonnet-4-6',
          maxTokens: 512,
          system: genSystemPrompt,
          messages: [
            { role: 'user', content: `Character name: ${missingName}\nStory context: ${conceptContext || 'No additional context'}` },
            { role: 'assistant', content: JSON.stringify(previousProposal) },
            { role: 'user', content: `The reviewer rejected this proposal. Feedback: "${decision.comment}".

Return an updated JSON proposal. Include a "changed_fields" array listing which fields you modified (from: "description", "image_prompt").
Return ONLY JSON. No markdown. No explanation.
{
  "description": "...",
  "image_prompt": "...",
  "changed_fields": ["field1", "field2"]
}` },
          ],
        });

        let retryText = retryMsg.content[0]?.text?.trim() || '';
        retryText = retryText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        try {
          const parsed = JSON.parse(retryText);
          // Validate changed_fields is an array of strings
          if (!Array.isArray(parsed.changed_fields)) {
            parsed.changed_fields = null;
          }
          proposal = parsed;
        } catch {
          // JSON parse failed — fall back to showing full proposal (no diff)
          console.warn(`  ⚠️  ${missingName}: failed to parse retry response — showing full proposal`);
          proposal = { description: retryText, image_prompt: proposal.image_prompt };
          previousProposal = null;
        }

        console.log(`  ↩️  ${missingName} re-generated`);
      }
    }
  }

  // ── D. Generate reference images (feedback-aware) ───────────────────
  // Skip characters that already have a referenceImageBuffer (from cache or episode customization)
  console.log('  🎨 Preparing character reference images...');

  for (const [name, character] of Object.entries(characterMap)) {
    // Skip if already has a reference image (from cache in section B or episode customization)
    if (character.referenceImageBuffer) {
      console.log(`  ✓ ${name}: already has reference image — skipping generation`);
      continue;
    }

    const charId = character.id;
    const charVersion = character.version || 1;
    const refPath = join(charTmpDir, `${name.toLowerCase()}.png`);

    // Try to load cached reference image from Supabase Storage
    try {
      const storagePath = `${charId}/v${charVersion}.png`;
      const cached = await downloadFromStorage({ bucket: BUCKETS.characters, path: storagePath });
      await fs.writeFile(refPath, cached);
      character.referenceImageBuffer = cached;
      console.log(`  ✓ ${name}: cached reference image (v${charVersion})`);
      continue;
    } catch {
      // Not cached — generate fresh
    }

    // Generate new reference image with Telegram approval (feedback-aware)
    let currentImagePrompt = (character.image_prompt || character.description || name) +
      `, full body, plain white background, reference sheet, ${artStyle}, child-friendly`;
    let imageApproved = false;

    for (let imgCycle = 0; imgCycle < MAX_IMAGE_CYCLES; imgCycle++) {
      try {
        const buffer = await generateSceneImage({
          prompt: currentImagePrompt,
          sceneNumber: 0,
          aspectRatio: '1:1',
        });
        await fs.writeFile(refPath, buffer);

        // Send photo + approval buttons
        await sendApprovalBotMedia({ filePath: refPath, type: 'photo', caption: `🎨 Reference image: ${name} (attempt ${imgCycle + 1})` });

        const callbackPrefix = `s3_img_${name}_${imgCycle}`;
        const msgId = await sendTelegramMessageWithButtons(
          `Approve reference image for ${name}?\n\nPrompt: ${currentImagePrompt.slice(0, 300)}`,
          callbackPrefix,
        );
        const decision = await waitForTelegramResponse(msgId, callbackPrefix);

        if (decision.approved) {
          character.referenceImageBuffer = buffer;
          try {
            await uploadCharacterImage({ characterId: charId, version: charVersion, buffer });
            console.log(`  ✓ ${name}: reference image approved + cached (v${charVersion})`);
          } catch (uploadErr) {
            console.warn(`  ⚠️  ${name}: approved but cache upload failed: ${uploadErr.message}`);
          }
          // Upload task-specific reference image and record URL in character_library (non-fatal)
          try {
            const refStoragePath = await uploadToStorage({
              bucket: BUCKETS.characters,
              path: `${taskId}/${name}_ref.png`,
              buffer,
              contentType: 'image/png',
            });
            await supabase.from('character_library').update({ reference_image_url: refStoragePath }).eq('name', name);
            console.log(`  ✓ ${name}: reference_image_url saved to character_library (${refStoragePath})`);
          } catch (refErr) {
            console.warn(`  ⚠️  ${name}: reference_image_url update failed (non-fatal): ${refErr.message}`);
          }
          imageApproved = true;
          break;
        }

        // Rejected — refine prompt via Claude using feedback
        console.log(`  ✗ ${name} image rejected (cycle ${imgCycle + 1}/${MAX_IMAGE_CYCLES}): ${decision.comment}`);
        if (decision.comment) {
          currentImagePrompt = await refineImagePrompt(currentImagePrompt, decision.comment);
          console.log(`  ↩️  ${name} image prompt refined`);
        }
      } catch (err) {
        console.warn(`  ⚠️  Reference image gen failed for ${name} (attempt ${imgCycle + 1}): ${err.message}`);
      }
    }

    if (!imageApproved) {
      console.warn(`  ⚠️  ${name}: no approved reference image after ${MAX_IMAGE_CYCLES} attempts — falling back to text-only`);
    }
  }

  // ── E. Post roster summary + return state ───────────────────────────
  const charSummary = Object.values(characterMap)
    .map(c => {
      const override = episodeOverrides[c.name];
      return `${c.name}: ${c.description}${override ? ` [episode tweak: ${override.tweakText}]` : ''}`;
    })
    .join('\n');
  await sendTelegramMessage(`👤 Final character roster:\n${charSummary}`);

  // Bug 4 fix: save lightweight characterVoiceMap (name → voiceId only, no image buffers)
  // Large image buffers in characterMap cause serialization issues and data loss on pipeline restart.
  // Stage 6 prefers characterVoiceMap for voice lookups.
  const characterVoiceMap = {};
  for (const [name, char] of Object.entries(characterMap)) {
    if (char.voice_id && char.voice_id !== 'PLACEHOLDER') {
      characterVoiceMap[name] = char.voice_id;
    }
  }

  console.log(`✅ Stage 3 complete. Characters: ${Object.keys(characterMap).join(', ')}`);
  return { ...state, characterMap, characterMapWithImages: characterMap, characterVoiceMap, episodeOverrides };
}
