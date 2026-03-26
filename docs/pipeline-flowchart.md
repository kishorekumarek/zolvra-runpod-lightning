# Tiny Tamil Tales — Full Pipeline Flowchart

> **⚠️ PARTIALLY STALE** — NEXUS (ops_tasks board) has been removed from the pipeline. All approvals now go through Telegram via Heimdall bot. Some flowchart sections below still reference ops_tasks polling; these are historical and do not reflect the current pipeline. The approval flow is now: `sendTelegramMessageWithButtons()` → `waitForTelegramResponse()` (long-poll, 24h timeout).

## ENTRY POINTS

```
[Friday/Manual Trigger]
        |
        v
  +-----------+     +------------------+
  | Path A:   |     | Path B:          |
  | No story  |     | User gave story  |
  | from user |     | outline          |
  +-----+-----+     +--------+---------+
        |                     |
        v                     v
  [Stage 0]            [Stage 1B] (planned)
  Research             Extract metadata
                       from user story
```

---

## STAGE 0 — WEEKLY RESEARCH (concept generation)

```
START Stage 0
    |
    v
fetchTrendSummary()
    | (currently hardcoded: "friendship, sharing, animals...")
    v
+-- Has ANTHROPIC_API_KEY? --+
|                             |
| YES                        | NO
v                             v
Claude Sonnet 4.6             getSampleConcepts()
"Generate 3-5 story           (3 hardcoded concepts)
 concepts for Tamil kids"          |
maxTokens: 1024                    |
    |                              |
    v                              |
Parse JSON response <--------------+
    |
    v
[For each concept (3-5)]
    |
    v
sendTelegramMessage()
  task_type: 'story_proposal'
  status: 'review'
    |
    v
END Stage 0
Output: concept cards in Telegram (non-blocking, sit for human review)
```

---

## STAGE 1 — CONCEPT SELECTION & TASK INIT

```
START Stage 1
    |
    v
Receive approved concept card ID
    |
    v
randomUUID() → taskId
    |
    v
Supabase INSERT → video_pipeline_runs
  task_id, stage=1, status='completed'
    |
    v
END Stage 1
Output: { taskId, concept: { title, theme, synopsis, characters[] } }
```

---

## STAGE 2 — SCRIPT GENERATION + PER-SCENE APPROVAL

```
START Stage 2
    |
    v
Load pipeline settings:
  +--> getVideoType() → 'long' | 'short'
  +--> getSetting('target_clips') → default: long=24, short=8
  +--> getSetting('clip_duration_seconds') → default: long=10, short=7
    |
    v
Supabase SELECT → character_library (approved=true)
  → characters[] with name, description, image_prompt, voice_id
    |
    v
Supabase SELECT count → video_pipeline_runs (stage=9, completed)
  → episodeNumber = count + 1
    |
    v
Load files:
  +--> tamil-style-guide.md (~15k chars, Tamil script rules)
  +--> video-feedback.md (~11k chars, production rules)
  +--> getSetting('voice_feedback') (accumulated TTS corrections)
    |
    v
buildSystemPrompt():
  +--> Dynamic speaker list from character_library
  +--> Dynamic character rules from character descriptions
  +--> Dynamic visual examples from image_prompts
  +--> Tamil style guide (injected)
  +--> Video feedback (injected)
  +--> Voice feedback (injected)
  +--> Story arc (intro/rising/climax/resolution)
  +--> concept.outline (if present — planned, not yet implemented)
  Total: ~32k chars / ~8.5k tokens
    |
    v
╔══════════════════════════════════════╗
║  GENERATION LOOP (max 3 attempts)    ║
╠══════════════════════════════════════╣
    |
    v
+-- Has ANTHROPIC_API_KEY? --+
|                             |
| YES                        | NO
v                             v
Claude Sonnet 4.6             getSampleResult()
maxTokens: 8192               (24 identical sample scenes)
"Generate complete scene           |
 list for {title}"                 |
    |                              |
    v                              |
Parse JSON <-----------------------+
  (strip markdown fences)
    |
    v
validateScenes():
  +-- Is scenes array? ────────────── NO → retry
  +-- scenes.length === targetClips? ─ NO → retry
  |
  v
  [For each scene]:
    +-- Has scene_number? ─────────── NO → retry
    +-- Has text? ─────────────────── NO → retry
    +-- Has visual_description? ───── NO → retry
    +-- speaker valid? ────────────── NO → auto-fix to 'narrator'
    +-- emotion valid? ────────────── NO → auto-fix to 'normal'
    +-- word count 15-30? ─────────── NO → retry
    |
    v
containsTamilUnicode() check:
  [For each scene]:
    +-- scene.text has Tamil Unicode? ─ NO → retry
    |
    v
Placeholder check:
  [For each scene]:
    +-- visual_description has forbidden text? ─ YES → throw error
    |   ("same locked description", "INSERT CHARACTER", etc.)
    |
    v
Auto-fill youtube_seo if missing
    |
    v
║  END GENERATION LOOP                 ║
╚══════════════════════════════════════╝
    |
    | (If all 3 attempts fail → throw error, pipeline dies)
    v
╔══════════════════════════════════════════════════════╗
║  PER-SCENE APPROVAL LOOP (scene 1 → scene 24)       ║
╠══════════════════════════════════════════════════════╣
    |
    v
Telegram: "Script ready: {title} — {N} scenes for review"
    |
    v
[For each scene]:
    |
    +-- Already approved (resume)? ─── YES → skip to next scene
    |
    v
  ┌─────────────────────────────────────────────┐
  │ APPROVAL LOOP (repeats until approved)       │
  ├─────────────────────────────────────────────┤
      |
      v
  sendTelegramMessageWithButtons():
    "Scene 3/24
     Speaker: kavin | Emotion: excited
     Text: ஐய்யோ! பாருங்க...
     Visual: A colorful peacock..."
    [✅ Approve]  [❌ Reject]
      |
      v
  sendTelegramMessage():
    task_type: 'script_proposal'
    (same content as Telegram message)
      |
      v
  waitForTelegramResponse(telegramMessageId, callbackPrefix):
    Long-poll Telegram approval bot (30s per poll):
      1. Callback query matching prefix
         - ✅ button → approved
         - ❌ button → prompt for feedback text
      2. Text message
         - "ok/approve/yes" → approved
         - "text: ..." → rejected with replacement
         - "stop pipeline" → PipelineAbortError
         - (anything else after reject) → rejected with feedback
    Also checks Supabase pipeline_abort flag. Timeout: 24h.
      |
      v
  +-- Decision? --+------------------+-------------------+
  |               |                  |                    |
  | APPROVED      | TEXT REPLACEMENT | FEEDBACK           |
  v               v                  v                    |
  Mark approved   comment matches    Claude regenerates   |
  Move to next    /^text:\s*(.+)/    single scene:        |
  scene           Direct update:     - surroundingContext  |
                  scene.text =         (scenes ±2)        |
                  replacement        - feedback comment    |
                  Log: "replaced     - full style guide   |
                  directly"          - character library   |
                                     Claude Sonnet 4.6    |
                                     maxTokens: 1024      |
                                     Returns new scene    |
                                     Update text +        |
                                     visual_description   |
                  |                  |                    |
                  +------------------+--------------------+
                  |
                  v
              (Loop back to send updated scene for re-approval)
      |
      v
  Supabase UPSERT → video_pipeline_runs
    pipeline_state: { scenes, approvedScenes }
    (resume-safe checkpoint)
  │                                              │
  └──────────────────────────────────────────────┘
    |
    v (all scenes approved)
║  END APPROVAL LOOP                               ║
╚══════════════════════════════════════════════════╝
    |
    v
Supabase UPSERT → video_pipeline_runs
  stage=2, status='completed', pipeline_state
    |
    v
sendTelegramMessage(): "Script Approved: {title}"
  (summary with first 3 scenes preview)
    |
    v
Telegram: "All {N} scenes approved for {title}"
    |
    v
END Stage 2
Output: {
  scenes[],        // 24 approved scene objects
  episodeNumber,
  youtube_seo,     // { title, description, tags }
  script,          // { metadata: { title, episode, characters[] }, youtube_seo }
  videoType        // 'long' | 'short'
}
```

---

## STAGE 3 — CHARACTER PREPARATION

```
START Stage 3
    |
    v
Get character names from script.metadata.characters
  (unique non-narrator speakers from approved scenes)
    |
    v
[For each character name]:
    |
    v
  Supabase SELECT → character_library
    WHERE name ILIKE '{name}' AND approved=true
    |
    +-- Found? ──── YES → add to characterMap
    |
    | NO
    v
  Add to missingCharacters[]
    |
    v
+-- Any missing characters? --+
|                              |
| YES                         | NO
v                              v
[For each missing]:            (continue)
  sendTelegramMessage():               |
    "New Character Required:       |
     {name}"                       |
    task_type: 'character_proposal'|
    Instructions to manually       |
    add to character_library       |
    |                              |
    v                              |
  throw Error()                    |
  "Missing characters require      |
   manual addition"                |
  *** PIPELINE HALTS ***           |
  (Manual: add to Supabase,       |
   restart pipeline from Stage 3)  |
                                   |
    <------------------------------+
    |
    v
╔════════════════════════════════════════╗
║  REFERENCE IMAGE GENERATION            ║
╠════════════════════════════════════════╣
    |
    v
mkdir /tmp/{taskId}/characters
    |
    v
[For each character in characterMap]:
    |
    v
  Try: downloadFromStorage()
    bucket: 'characters'
    path: '{charId}/v{version}.png'
    |
    +-- Cache hit? ── YES → write to tmpDir, set referenceImageBuffer
    |                        skip to next character
    | NO (cache miss)
    v
  generateSceneImage():
    prompt: "{image_prompt}, full body, plain white background,
             reference sheet, 3D cartoon animation still,
             Pixar-style, child-friendly"
    aspectRatio: '1:1'
    API: Google Gemini 3.1 Flash Image
    |
    +-- Success? ── YES → write PNG to tmpDir
    |               |     upload to Storage (cache)
    |               |     set referenceImageBuffer
    |               v
    | NO            (continue to next character)
    v
  Warning: "falling back to text-only"
  (character has no reference image)
║                                        ║
╚════════════════════════════════════════╝
    |
    v
+-- isFeedbackCollectionMode()? --+
|                                  |
| YES                             | NO
v                                  v
sendTelegramMessage():                 (skip)
  "[Feedback] Stage 3:                |
   Character Roster Review"           |
  (non-blocking, does NOT pause)      |
    |                                  |
    +----------------------------------+
    |
    v
END Stage 3
Output: {
  characterMap: { name → { id, name, description, image_prompt,
                            voice_id, referenceImageBuffer } },
  characterMapWithImages: (same ref)
}
```

---

## STAGE 4 — SCENE ILLUSTRATION

```
START Stage 4
    |
    v
Determine aspect ratio:
  videoType='short' → '9:16'
  videoType='long'  → '16:9'
    |
    v
Supabase SELECT → scene_assets
  WHERE video_id=taskId AND status='completed'
  → doneScenes set (for resume)
    |
    v
Check isFeedbackCollectionMode()
    |
    v
╔════════════════════════════════════════════════════╗
║  CURRENT: Generate ALL images first, then approve  ║
║  (TODO: merge into generate-one-approve-one loop)  ║
╠════════════════════════════════════════════════════╣
    |
    v
[For each scene — sequential, 7s delay]:
    |
    +-- Already done (resume)? ── YES → load from scene_assets, skip
    |
    v
  illustrateScene():
    |
    v
    Lookup character from characterMap[scene.speaker]
    |
    v
    Collect referenceImageBuffers (max 4 per Gemini limit)
    |
    v
    buildScenePrompt():
      "3D cartoon animation still, Pixar-style, child-friendly,
       {character.image_prompt},
       {scene.visual_description},
       children's animated illustration style, soft watercolor,
       no text, no watermark, safe for kids"
    |
    v
    withRetry(generateSceneImage(), 3 attempts, 15s delay):
      API: Google Gemini 3.1 Flash Image
      aspectRatio: '16:9' or '9:16'
      referenceImages: character ref PNGs
      |
      +-- 429 quota error? → createPlaceholderPng() (blue-gray fallback)
      |
      v
    Write PNG → tmpDir/scenes/scene_01_image.png
    |
    v
    uploadSceneImage() → Supabase Storage
    |
    v
    Supabase UPSERT → scene_assets
      { video_id, scene_number, image_url, prompt_used, status='completed' }
    |
    v
    calcImageCost() → tracker.addCost()
    |
    v
  Wait 7 seconds (Imagen rate limit: 10 req/min)
    |
    v
(next scene)
║                                                    ║
╚════════════════════════════════════════════════════╝
    |
    v
+-- failureCount > 5? ── YES → throw error, pipeline halts
|
| NO
v
+-- Failures > 0? ── YES → sendTelegramMessage() per failed scene
|                          "Manual asset needed: Scene {N}"
v
Collect sceneImagePaths { scene_number → { imagePath, storagePath } }
    |
    v
╔════════════════════════════════════════════════════╗
║  IMAGE APPROVAL (feedback mode only)               ║
╠════════════════════════════════════════════════════╣
    |
    +-- isFeedbackCollectionMode()? ── NO → skip approval
    |
    v
Telegram: "Stage 4: {N} scene images ready for review"
    |
    v
[For each scene]:
    |
    +-- Already approved (resume)? ── YES → skip
    |
    v
  ┌──────────────────────────────────────┐
  │ IMAGE APPROVAL LOOP (per scene)       │
  ├──────────────────────────────────────┤
      |
      v
  sendTelegramPhoto():
    caption: "Scene 3 (kavin, excited)\n{visual_description}"
      |
      v
  sendTelegramMessage():
    "Scene 3 Image Review"
    task_type: 'stage_review'
      |
      v
  waitForTelegramResponse(cardId):
    Poll Telegram every 30s (no Telegram buttons for images yet)
      |
      +-- Approved? ── YES → mark approved, next scene
      |
      | REJECTED (with comment)
      v
  Regenerate image:
    illustrateScene() again
    (new prompt? same prompt? — uses same visual_description)
    Wait 7s (rate limit)
      |
      v
  (loop back for re-approval)
      |
      v
  Supabase UPSERT → video_pipeline_runs
    pipeline_state: { sceneImagePaths, approvedImages }
  │                                      │
  └──────────────────────────────────────┘
║                                                    ║
╚════════════════════════════════════════════════════╝
    |
    v
END Stage 4
Output: {
  sceneImagePaths: { scene_number → { imagePath, storagePath } },
  approvedImages: { scene_number → { approved: true } },
  tmpDir
}
```

---

## STAGE 5 — ANIMATION (Image-to-Video)

```
START Stage 5
    |
    v
Filter validScenes (scenes with sceneImagePaths entries)
    |
    v
[For each valid scene — sequential, 10s delay]:
    |
    v
  animateScene():
    |
    v
    Get signed URL for scene image from Supabase Storage
    |
    v
    buildWanPrompt():
      "{visual_description}" (max 300 chars)
    |
    v
    withRetry(submitWanJob(), 3 attempts, 30s delay):
      POST → kie.ai/api/v1/jobs/createTask
      model: 'wan/2-6-image-to-video'
      duration: '10' (10 seconds)
      resolution: '1080p'
      Returns: taskId
    |
    v
    withRetry(pollWanJob(taskId), 2 attempts, 15s delay):
      GET → kie.ai/api/v1/jobs/recordInfo?taskId={taskId}
      Poll every 15s, timeout: 600s (10 min)
      |
      +-- state='success' → get resultUrl
      +-- state='fail' → check failMsg
      |     +-- NSFW? → regenerateSafeImage() + retry
      |     +-- Other? → throw error
      +-- timeout → throw error
    |
    v
    downloadWanVideo(resultUrl) → MP4 buffer
    |
    v
    Write MP4 → tmpDir/scenes/scene_01_anim.mp4
    |
    v
    uploadSceneAnimation() → Supabase Storage
    |
    v
    Supabase UPDATE → scene_assets
      SET animation_url = storagePath
    |
    v
    calcAnimationCost() → tracker.addCost()
    |
    v
  Wait 10 seconds (Wan rate limit)
    |
    v
(next scene)
    |
    v
+-- Failure ratio > 80%? ── YES → throw error, pipeline halts
|
| NO
v
Failed scenes:
  +-- NSFW rejection? → regenerateSafeImage() + retry animation
  +-- Other failure? → staticImageFallback()
      FFmpeg: still image → 10s video with zoompan effect
    |
    v
+-- isFeedbackCollectionMode()? --+
|                                  |
| YES                             | NO
v                                  v
sendTelegramMessage():                 (skip)
  "[Feedback] Stage 5:                |
   Scene Animations Review"           |
  List all animation paths            |
  (non-blocking)                      |
    |                                  |
    +----------------------------------+
    |
    v
END Stage 5
Output: {
  sceneAnimPaths: { scene_number → { animPath, storagePath } }
}
```

---

## STAGE 6 — VOICE GENERATION (TTS)

```
START Stage 6
    |
    v
mkdir tmpDir/audio/
    |
    v
Load resume state:
  approvedSceneAudio (from state)
  enhancedSceneTexts (from state)
  sceneAudioPaths (from state)
    |
    v
╔══════════════════════════════════════╗
║  BATCH DIALOGUE ENHANCEMENT          ║
╠══════════════════════════════════════╣
    |
    v
Filter scenesToEnhance (not yet in enhancedSceneTexts)
    |
    v
enhanceDialoguesForTTS(scenesToEnhance):
  Claude Haiku 4.5, maxTokens: 4096
  Input per scene:
    "Scene {N} | Speaker: {s} | Emotion: {e} | Visual: {v} | Text: {t}"
  |
  v
  Claude adds:
    - Voice direction tags: [happy], [excited], [whisper], etc.
    - Non-verbal tags: [laughing], [sighs], [gasps], etc.
    - Environmental SFX: [birds chirping], [rain], etc.
    - Extended vowels: ரொம்பாாா!, wowwww!
    - Punctuation: !, ?, ...
    - NO CAPITALS (Tamil has no uppercase)
  |
  v
  Parse JSON array → { scene_number → enhanced_text }
  |
  +-- Parse error? → fallbackEnhance()
  |                   Prepend [emotion] to original text
  v
  Fill missing scenes with fallback
║                                      ║
╚══════════════════════════════════════╝
    |
    v
Check isFeedbackCollectionMode()
    |
    v
╔══════════════════════════════════════════════════════╗
║  PER-SCENE TTS GENERATION + APPROVAL                 ║
╠══════════════════════════════════════════════════════╣
    |
    v
[For each scene]:
    |
    +-- Already approved (resume)? ── YES → restore audioPath, skip
    |
    v
  Look up voiceId:
    VOICE_MAP[scene.speaker] → ElevenLabs voice ID
    Fallback: VOICE_MAP.default (Narrator Female)
    |
    v
  enhancedText = enhancedSceneTexts[sceneNum]
    || fallback: "[{emotion}] {text}"
    |
    v
  ┌──────────────────────────────────────┐
  │ TTS + APPROVAL LOOP (per scene)       │
  ├──────────────────────────────────────┤
      |
      v
  withRetry(callElevenLabs(), 3 attempts, 10s delay):
    POST → elevenlabs.io/v1/text-to-speech/{voiceId}
    Body: {
      text: enhancedText,
      model_id: 'eleven_v3',
      voice_settings: {}  ← empty! emotion via [tags] only
    }
    Returns: MP3 buffer
      |
      v
  Write MP3 → tmpDir/audio/scene_01_audio.mp3
  Track totalChars for cost
      |
      v
  +-- isFeedbackCollectionMode()? --+
  |                                  |
  | NO (auto-mode)                  | YES (feedback mode)
  v                                  v
  Auto-approve                   sendTelegramAudio():
  Mark done                        caption: "Scene 3 (kavin, excited):
  Next scene                        {enhancedText}"
                                     |
                                     v
                                 sendTelegramMessage():
                                   "Scene 3 Voice Review"
                                   Shows original + enhanced text
                                     |
                                     v
                                 waitForTelegramResponse(cardId):
                                   Poll Telegram every 30s
                                     |
                                     +-- Approved? ── YES → mark done
                                     |
                                     | REJECTED
                                     v
                                 recordVoiceFeedback()
                                   (saves to pipeline_feedback)
                                     |
                                     v
                                 +-- Comment matches
                                 |   /change text to "..."/ ?
                                 |
                                 | YES                    | NO
                                 v                        v
                                 Replace text →           extractEmotionHint():
                                 enhanceSingleDialogue()    "more excited" → excited
                                 with new text              "too flat" → excited
                                                            "sadder" → sad
                                                          |
                                                          v
                                                        enhanceSingleDialogue()
                                                        with emotion override
                                 |                        |
                                 +------------------------+
                                 |
                                 v
                              (loop: re-generate TTS with new enhanced text)
      |
      v
  Supabase UPSERT → video_pipeline_runs
    pipeline_state: { enhancedSceneTexts, approvedSceneAudio, sceneAudioPaths }
  │                                      │
  └──────────────────────────────────────┘
║                                                      ║
╚══════════════════════════════════════════════════════╝
    |
    v
calcTTSCost(totalChars) → tracker.addCost()
    |
    v
END Stage 6
Output: {
  sceneAudioPaths: { scene_number → audioPath },
  enhancedSceneTexts: { scene_number → enhanced_text },
  approvedSceneAudio: { scene_number → { audioPath, approved } }
}
```

---

## STAGE 7 — VIDEO ASSEMBLY

```
START Stage 7
    |
    v
getBgmPath() → assets/bgm/kids_folk_01.mp3
  (null if file missing — BGM skipped)
    |
    v
Determine scale filter:
  videoType='long'  → scale=1280:720,crop=1280:720
  videoType='short' → scale=1080:1920,crop=1080:1920
    |
    v
bgmOffset = 0 (tracks cumulative BGM position)
    |
    v
╔═══════════════════════════════════════════════╗
║  PER-SCENE ASSEMBLY                            ║
╠═══════════════════════════════════════════════╣
    |
    v
[For each scene]:
    |
    v
  Get paths:
    animPath  ← sceneAnimPaths[sceneNum] (MP4 clip)
    audioPath ← sceneAudioPaths[sceneNum] (MP3 voice)
    sfxPath   ← getSfxPath(environment) (ambient loop)
    bgmPath   ← getBgmPath() (background music)
    |
    +-- Has animPath? --+
    |                    |
    | YES               | NO
    v                    v
    mergeClipWithAudio() stillImageToVideo()
                          (imagePath → 10s video
                           with zoompan effect)
                           then mergeClipWithAudio()
    |
    v
  FFmpeg complex filter:
    Input 0: animation clip (stream_loop -1)
    Input 1: voice audio    → volume=1.0
    Input 2: SFX loop       → volume=0.3, trim to sceneDur
    Input 3: BGM at offset  → volume=0.12, trim to sceneDur
    Video: scale + crop to target resolution
    Audio: amix 3 inputs → [aout]
    Duration: max(clip_duration, audio_duration)
    |
    v
  Output: scene_01_final.mp4
  bgmOffset += sceneDuration
    |
    v
(next scene)
║                                               ║
╚═══════════════════════════════════════════════╝
    |
    v
╔═══════════════════════════════════════════════╗
║  CONCATENATION                                 ║
╠═══════════════════════════════════════════════╣
    |
    v
Create concat.txt (FFmpeg concat demuxer input):
  file 'scene_01_final.mp4'
  file 'scene_02_final.mp4'
  ...
    |
    v
FFmpeg concat → concat.mp4
║                                               ║
╚═══════════════════════════════════════════════╝
    |
    v
╔═══════════════════════════════════════════════╗
║  FINAL BGM OVERLAY                             ║
╠═══════════════════════════════════════════════╣
    |
    v
applyFinalBgm():
  BGM volume: 0.1
  Fade in: 2s from start
  Fade out: 3s before end
  Loop BGM to fill entire video duration
  Mix with existing audio track
    |
    v
Output: bgm_final.mp4
║                                               ║
╚═══════════════════════════════════════════════╝
    |
    v
╔═══════════════════════════════════════════════╗
║  LOGO WATERMARK                                ║
╠═══════════════════════════════════════════════╣
    |
    v
+-- assets/channel-logo.png exists? --+
|                                      |
| YES                                 | NO
v                                      v
FFmpeg overlay:                        (skip silently)
  Scale logo to 12% of video width        |
  Position: top-right (W-w-20, 20)        |
    |                                      |
    +--------------------------------------+
    |
    v
Output: logo_final.mp4
║                                               ║
╚═══════════════════════════════════════════════╝
    |
    v
╔═══════════════════════════════════════════════╗
║  END CARD                                      ║
╠═══════════════════════════════════════════════╣
    |
    v
+-- videoType? --+
|                 |
| 'long'         | 'short'
v                 v
end-card.mp4      shorts_end_card.mp4
    |
    v
+-- End card file exists? --+
|                            |
| YES                       | NO
v                            v
Re-encode both to match      (skip silently)
  dimensions (H.264, 30fps)      |
FFmpeg concat demuxer            |
  main + end card                |
  -shortest flag (sync fix)      |
    |                            |
    +----------------------------+
    |
    v
Output: final_video.mp4
║                                               ║
╚═══════════════════════════════════════════════╝
    |
    v
+-- isFeedbackCollectionMode()? --+
|                                  |
| YES                             | NO
v                                  v
sendTelegramMessage():                 (skip)
  "[Feedback] Stage 7:                |
   Assembled Video Review"            |
  Shows: path + duration              |
  (non-blocking)                      |
    |                                  |
    +----------------------------------+
    |
    v
END Stage 7
Output: {
  finalVideoPath: "/tmp/{taskId}/assembly/final_video.mp4",
  finalDurationSeconds: 240
}
```

---

## STAGE 8 — YOUTUBE UPLOAD & REVIEW

```
START Stage 8
    |
    v
withRetry(uploadVideoUnlisted(), 2 attempts, 10s delay):
  YouTube Data API: videos.insert
  Privacy: UNLISTED
  Title: youtube_seo.title
  Description: youtube_seo.description
  Tags: youtube_seo.tags
  Returns: youtubeVideoId
    |
    v
+-- videoType='short'? --+
|                         |
| YES                    | NO
v                         v
YouTube API:              (skip)
  GET videos.list            |
  Check if #Shorts exists    |
  If not → PATCH to add      |
  Set categoryId=27           |
    |                         |
    +-------------------------+
    |
    v
youtubeUrl = "https://youtu.be/{youtubeVideoId}"
    |
    v
Supabase UPDATE → video_pipeline_runs
  stage=8, status='awaiting_review'
    |
    v
sendTelegramMessage():
  "{title}
   YouTube: {youtubeUrl}
   Duration: {duration}s
   UNLISTED — ready for your review"
    |
    v
sendTelegramMessage():
  task_type: 'video_delivery'
  priority: 'high'
  content_url: youtubeUrl
  "Approve (publish) / Request Changes"
    |
    v
END Stage 8
Output: {
  youtubeVideoId,
  youtubeUrl
}
(Pipeline continues to Stage 9 automatically — does NOT wait for approval here)
```

---

## STAGE 9 — PUBLISH & FEEDBACK ANALYSIS

```
START Stage 9
    |
    v
*** NOTE: Video stays UNLISTED ***
*** Darl publishes manually via YouTube Studio ***
    |
    v
withRetry(addToPlaylist(), 2 attempts, 5s delay):
  YouTube API: playlistItems.insert
  +-- Error? → warning only (non-fatal)
    |
    v
+-- videoType='long'? --+
|                        |
| YES                   | NO
v                        v
Log: "End card eligible  Log: "Skipping end card
— attach via YouTube     — not applicable for
  Studio"                  Shorts"
    |                        |
    +------------------------+
    |
    v
Supabase INSERT → pipeline_feedback
  { video_id, stage=9, decision='approved',
    comment='Published to YouTube' }
    |
    v
╔══════════════════════════════════════╗
║  FEEDBACK COLLECTION TRACKING        ║
╠══════════════════════════════════════╣
    |
    v
getSetting('feedback_collection_completed') → N
setSetting('feedback_collection_completed', N+1)
    |
    v
+-- N+1 >= target? --+
|                      |
| YES                 | NO
v                      v
setSetting(            (continue)
  'feedback_collection     |
   _mode', false)          |
sendTelegramMessage():         |
  "Feedback Collection     |
   Complete"               |
  task_type: 'milestone'   |
    |                      |
    +----------------------+
║                                      ║
╚══════════════════════════════════════╝
    |
    v
╔══════════════════════════════════════╗
║  FEEDBACK ANALYSIS                   ║
╠══════════════════════════════════════╣
    |
    v
analyzeVideoFeedback(taskId):
  Supabase SELECT → pipeline_feedback for this video
  Summarize patterns (non-critical, warnings on error)
    |
    v
+-- completed % 5 === 0? --+
|                            |
| YES                       | NO
v                            v
runBatchFeedbackAnalysis():  (skip)
  Aggregate last 5 videos       |
  Detect patterns                |
  Update voice_feedback          |
    |                            |
    +----------------------------+
║                                      ║
╚══════════════════════════════════════╝
    |
    v
sendTelegramMessage():
  task_type: 'milestone'
  "{title} — Published"
  YouTube URL + total count
    |
    v
END Stage 9
Output: {
  published: true,
  publishedAt: timestamp
}
```

---

## BACKGROUND PROCESSES

```
╔══════════════════════════════════════════════════╗
║  PIPELINE WATCHER (daemon — always running)      ║
╠══════════════════════════════════════════════════╣
    |
    v
  loop() every 30 seconds:
    |
    v
  Supabase SELECT → video_pipeline_runs
    WHERE status='failed' OR status='aborted'
    (watcher mainly needed for resume after crashes)
    |
    v
  [For each approved script card]:
    |
    v
    Find matching video_pipeline_runs:
      +-- stage=2, status='awaiting_review'?
      +-- stage=3 NOT started?
      |
      | BOTH TRUE
      v
    Atomic claim:
      UPDATE video_pipeline_runs
        SET status='completed'
        WHERE task_id AND stage=2
          AND status='awaiting_review'
      |
      +-- Claim success? ── NO → skip (another worker claimed)
      |
      | YES
      v
    spawn('node', ['launch-pipeline.mjs', conceptId, '3', taskId])
      detached: true
      stdio → /tmp/pipeline-{taskId}-stage3.log
      child.unref()
    |
    v
  (sleep 30s, loop)
║                                                  ║
╚══════════════════════════════════════════════════╝

*** NOTE: With Stage 2 now handling approval inline,
*** the watcher is mainly needed for resume after crashes.
*** Stage 2 sets status='completed' (not 'awaiting_review')
*** so the watcher won't trigger for normal flow.
```

---

## EXTERNAL SERVICES MAP

```
┌─────────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ Claude Sonnet 4.6   │  │ Claude Haiku 4.5 │  │ ElevenLabs v3   │
│ Stage 0: concepts   │  │ Stage 6: enhance │  │ Stage 6: TTS    │
│ Stage 2: script     │  │ dialogue + tags   │  │ Per-scene MP3   │
│ Stage 2: regen scene│  └──────────────────┘  │ Emotion via tags│
└─────────────────────┘                         └─────────────────┘

┌─────────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ Gemini 3.1 Flash    │  │ Wan 2.6 (kie.ai) │  │ YouTube Data API│
│ Stage 3: char refs  │  │ Stage 5: animate │  │ Stage 8: upload │
│ Stage 4: scene imgs │  │ Image → 10s video│  │ Stage 9: playlist│
│ 1:1 refs, 16:9/9:16│  │ 1080p resolution │  │ #Shorts tag     │
└─────────────────────┘  └──────────────────┘  └─────────────────┘

┌─────────────────────┐  ┌──────────────────┐
│ Telegram Bot API    │  │ Supabase         │
│ Send: text, photo,  │  │ DB: pipeline_runs│
│   audio, buttons    │  │   video_pipeline_│
│ Receive: callbacks, │  │   runs, character│
│   text replies      │  │   _library, etc. │
│ Stage 2,4,6,8       │  │ Storage: images, │
└─────────────────────┘  │   animations     │
                          └──────────────────┘
```

---

## DATA FLOW SUMMARY

```
Stage 0 → concepts[]
Stage 1 → { taskId, concept }
Stage 2 → { scenes[], episodeNumber, youtube_seo, script, videoType }
Stage 3 → { characterMap, characterMapWithImages }
Stage 4 → { sceneImagePaths, approvedImages, tmpDir }
Stage 5 → { sceneAnimPaths }
Stage 6 → { sceneAudioPaths, enhancedSceneTexts, approvedSceneAudio }
Stage 7 → { finalVideoPath, finalDurationSeconds }
Stage 8 → { youtubeVideoId, youtubeUrl }
Stage 9 → { published: true, publishedAt }
```

---

## APPROVAL GATES SUMMARY

```
BLOCKING (pipeline waits):
  Stage 2: Per-scene script approval   → Telegram buttons
  Stage 4: Per-scene image approval     → Telegram photo + buttons  (feedback mode)
  Stage 5: Per-scene animation approval → Telegram video + buttons  (feedback mode)
  Stage 6: Per-scene voice approval     → Telegram audio + buttons  (feedback mode)

NON-BLOCKING (pipeline continues):
  Stage 0: Concept summaries            → Telegram message
  Stage 3: Character roster review      → Telegram message  (feedback mode)
  Stage 7: Assembly review              → Telegram message  (feedback mode)
  Stage 8: YouTube upload notification  → Telegram message
  Stage 9: Published milestone          → Telegram message

HALTING (pipeline crashes, manual restart):
  Stage 3: Missing characters           → Telegram message + throw error
```
