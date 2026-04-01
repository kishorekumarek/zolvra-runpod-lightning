# Tiny Tamil Tales — Full Pipeline Flowchart

> Updated 2026-03-28 to reflect the pipeline schema rewrite.

## ENTRY POINT

```
[User provides story file]
        |
        v
  launch-pipeline-from-story.mjs [--task_id <existing>]
        |
        v
  +-- task_id provided? --+
  |                        |
  | YES (resume)          | NO (fresh run)
  v                        v
  Supabase SELECT         randomUUID() -> task_id
  pipeline_state           |
  Skip completed stages    v
  Resume from next         Supabase INSERT -> pipeline_state
        |                  (hub row created)
        +------------------+
        |
        v
  [Stage 1B]
```

---

## STAGE 1B — STORY EXTRACTION

```
START Stage 1B
    |
    v
Read user story file from disk
    |
    v
Extract metadata:
  title, theme, synopsis, characters[]
    |
    v
Supabase INSERT -> concepts
  (FK -> pipeline_state.task_id)
    |
    v
Supabase UPDATE -> pipeline_state
  stage=1B, status='completed'
    |
    v
END Stage 1B
```

---

## STAGE 2 — SCRIPT GENERATION + PER-SCENE APPROVAL

```
START Stage 2
    |
    v
Supabase SELECT -> concepts
  WHERE task_id = {task_id}
    |
    v
Load pipeline settings:
  +--> getVideoType() -> 'long' | 'short'
  +--> getSetting('target_clips') -> default: long=24, short=8
  +--> getSetting('clip_duration_seconds') -> default: long=10, short=7
    |
    v
Supabase SELECT -> character_library (approved=true)
  -> characters[] with name, description, image_prompt, voice_id
    |
    v
Supabase SELECT count -> video_pipeline_runs (stage=8, completed)
  -> episodeNumber = count + 1
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
  +--> concept.outline (from user story)
  Total: ~32k chars / ~8.5k tokens
    |
    v
+=============================================+
|  GENERATION LOOP (max 3 attempts)            |
+==============================================+
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
  +-- Is scenes array? -------------------- NO -> retry
  +-- scenes.length === targetClips? ------- NO -> retry
  |
  v
  [For each scene]:
    +-- Has scene_number? ----------------- NO -> retry
    +-- Has text? ------------------------- NO -> retry
    +-- Has visual_description? ----------- NO -> retry
    +-- speaker valid? -------------------- NO -> auto-fix to 'narrator'
    +-- emotion valid? -------------------- NO -> auto-fix to 'normal'
    +-- word count 15-30? ----------------- NO -> retry
    |
    v
containsTamilUnicode() check:
  [For each scene]:
    +-- scene.text has Tamil Unicode? ----- NO -> retry
    |
    v
Placeholder check:
  [For each scene]:
    +-- visual_description has forbidden text? -- YES -> throw error
    |   ("same locked description", "INSERT CHARACTER", etc.)
    |
    v
Auto-fill youtube_seo if missing
    |
    v
|  END GENERATION LOOP                     |
+===========================================+
    |
    | (If all 3 attempts fail -> throw error, pipeline dies)
    v
Supabase INSERT -> scenes
  (one row per scene, FK -> pipeline_state.task_id)
    |
    v
Supabase INSERT -> youtube_seo
  (FK -> pipeline_state.task_id)
    |
    v
+======================================================+
|  PER-SCENE APPROVAL LOOP (scene 1 -> scene 24)       |
+=======================================================+
    |
    v
Telegram: "Script ready: {title} -- {N} scenes for review"
    |
    v
[For each scene]:
    |
    +-- Already approved (resume)? ---- YES -> skip to next scene
    |
    v
  +---------------------------------------------+
  | APPROVAL LOOP (repeats until approved)       |
  +----------------------------------------------+
      |
      v
  sendTelegramMessageWithButtons():
    "Scene 3/24
     Speaker: kavin | Emotion: excited
     Text: ...
     Visual: A colorful peacock..."
    [Approve]  [Reject]
      |
      v
  waitForTelegramResponse(telegramMessageId, callbackPrefix):
    Long-poll Telegram approval bot (30s per poll):
      1. Callback query matching prefix
         - Approve button -> approved
         - Reject button -> prompt for feedback text
      2. Text message
         - "ok/approve/yes" -> approved
         - "text: ..." -> rejected with replacement
         - "stop pipeline" -> PipelineAbortError
         - (anything else after reject) -> rejected with feedback
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
                  scene.text =         (scenes +/-2)      |
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
  Supabase UPDATE -> scenes
    (approved flag per scene, updated text if changed)
  +----------------------------------------------+
    |
    v (all scenes approved)
|  END APPROVAL LOOP                               |
+===================================================+
    |
    v
Supabase UPDATE -> pipeline_state
  stage=2, status='completed'
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
```

---

## STAGE 3 — CHARACTER PREPARATION

```
START Stage 3
    |
    v
Supabase SELECT -> scenes
  WHERE task_id = {task_id}
    |
    v
Get unique non-narrator speaker names from scenes
    |
    v
[For each character name]:
    |
    v
  Supabase SELECT -> character_library
    WHERE name ILIKE '{name}' AND approved=true
    |
    +-- Found? ---- YES -> add to characterMap
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
   restart pipeline with task_id)  |
                                   |
    <------------------------------+
    |
    v
+========================================+
|  REFERENCE IMAGE GENERATION             |
+=========================================+
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
    +-- Cache hit? -- YES -> write to tmpDir, set referenceImageBuffer
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
    +-- Success? -- YES -> write PNG to tmpDir
    |               |     upload to Storage (cache)
    |               |     set referenceImageBuffer
    |               v
    | NO            (continue to next character)
    v
  Warning: "falling back to text-only"
  (character has no reference image)
+=========================================+
    |
    v
Supabase INSERT -> episode_characters
  (one row per character, FK -> pipeline_state.task_id)
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
Supabase UPDATE -> pipeline_state
  stage=3, status='completed'
    |
    v
END Stage 3
```

---

## STAGE 6 — VOICE GENERATION (TTS)

```
START Stage 6
    |
    v
Supabase SELECT -> scenes
  WHERE task_id = {task_id}
    |
    v
Supabase SELECT -> episode_characters
  WHERE task_id = {task_id}
    |
    v
mkdir tmpDir/audio/
    |
    v
Load resume state from DB:
  approvedSceneAudio, enhancedSceneTexts, sceneAudioPaths
    |
    v
+======================================+
|  BATCH DIALOGUE ENHANCEMENT           |
+=======================================+
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
    - Extended vowels
    - Punctuation: !, ?, ...
    - NO CAPITALS (Tamil has no uppercase)
  |
  v
  Parse JSON array -> { scene_number -> enhanced_text }
  |
  +-- Parse error? -> fallbackEnhance()
  |                   Prepend [emotion] to original text
  v
  Fill missing scenes with fallback
+=======================================+
    |
    v
Check isFeedbackCollectionMode()
    |
    v
+======================================================+
|  PER-SCENE TTS GENERATION + APPROVAL                  |
+=======================================================+
    |
    v
[For each scene]:
    |
    +-- Already approved (resume)? ---- YES -> restore audioPath, skip
    |
    v
  Look up voiceId:
    VOICE_MAP[scene.speaker] -> ElevenLabs voice ID
    Fallback: VOICE_MAP.default (Narrator Female)
    |
    v
  enhancedText = enhancedSceneTexts[sceneNum]
    || fallback: "[{emotion}] {text}"
    |
    v
  +--------------------------------------+
  | TTS + APPROVAL LOOP (per scene)       |
  +---------------------------------------+
      |
      v
  withRetry(callElevenLabs(), 3 attempts, 10s delay):
    POST -> elevenlabs.io/v1/text-to-speech/{voiceId}
    Body: {
      text: enhancedText,
      model_id: 'eleven_v3',
      voice_settings: {}  <-- empty! emotion via [tags] only
    }
    Returns: MP3 buffer
      |
      v
  Write MP3 -> tmpDir/audio/scene_01_audio.mp3
  Track totalChars for cost
      |
      v
  Upload MP3 -> Supabase Storage
    bucket: 'audio'
    path: '{task_id}/scene_{N}.mp3'
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
                                     +-- Approved? ---- YES -> mark done
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
                                 Replace text ->          extractEmotionHint():
                                 enhanceSingleDialogue()    "more excited" -> excited
                                 with new text              "too flat" -> excited
                                                            "sadder" -> sad
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
  Supabase UPDATE -> scenes
    (enhanced text, audio storage path, approval status)
  +---------------------------------------+
+=======================================================+
    |
    v
calcTTSCost(totalChars) -> tracker.addCost()
    |
    v
Supabase UPDATE -> pipeline_state
  stage=6, status='completed'
    |
    v
END Stage 6
```

---

## STAGE 4 — SCENE ILLUSTRATION

```
START Stage 4
    |
    v
Supabase SELECT -> scenes
  WHERE task_id = {task_id}
    |
    v
Supabase SELECT -> episode_characters
  WHERE task_id = {task_id}
    |
    v
Determine aspect ratio:
  videoType='short' -> '9:16'
  videoType='long'  -> '16:9'
    |
    v
Supabase SELECT -> scenes
  WHERE task_id AND image_status='completed'
  -> doneScenes set (for resume)
    |
    v
Check isFeedbackCollectionMode()
    |
    v
+====================================================+
|  CURRENT: Generate ALL images first, then approve   |
|  (TODO: merge into generate-one-approve-one loop)   |
+=====================================================+
    |
    v
[For each scene -- sequential, 7s delay]:
    |
    +-- Already done (resume)? ---- YES -> load from scenes table, skip
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
      +-- 429 quota error? -> createPlaceholderPng() (blue-gray fallback)
      |
      v
    Write PNG -> tmpDir/scenes/scene_01_image.png
    |
    v
    uploadSceneImage() -> Supabase Storage
    |
    v
    Supabase UPDATE -> scenes
      SET image_url, prompt_used, image_status='completed'
    |
    v
    calcImageCost() -> tracker.addCost()
    |
    v
  Wait 7 seconds (Imagen rate limit: 10 req/min)
    |
    v
(next scene)
+=====================================================+
    |
    v
+-- failureCount > 5? ---- YES -> throw error, pipeline halts
|
| NO
v
+-- Failures > 0? ---- YES -> sendTelegramMessage() per failed scene
|                          "Manual asset needed: Scene {N}"
v
+====================================================+
|  IMAGE APPROVAL (feedback mode only)                |
+=====================================================+
    |
    +-- isFeedbackCollectionMode()? ---- NO -> skip approval
    |
    v
Telegram: "Stage 4: {N} scene images ready for review"
    |
    v
[For each scene]:
    |
    +-- Already approved (resume)? ---- YES -> skip
    |
    v
  +--------------------------------------+
  | IMAGE APPROVAL LOOP (per scene)       |
  +---------------------------------------+
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
    Poll Telegram every 30s
      |
      +-- Approved? ---- YES -> mark approved, next scene
      |
      | REJECTED (with comment)
      v
  Regenerate image:
    illustrateScene() again
    Wait 7s (rate limit)
      |
      v
  (loop back for re-approval)
      |
      v
  Supabase UPDATE -> scenes
    (image approval status)
  +---------------------------------------+
+=====================================================+
    |
    v
Supabase UPDATE -> pipeline_state
  stage=4, status='completed'
    |
    v
END Stage 4
```

---

## STAGE 5 — ANIMATION (Image-to-Video)

```
START Stage 5
    |
    v
Supabase SELECT -> scenes
  WHERE task_id = {task_id}
    |
    v
Filter validScenes (scenes with image_url entries)
    |
    v
[For each valid scene -- sequential, 10s delay]:
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
      POST -> kie.ai/api/v1/jobs/createTask
      model: 'wan/2-6-image-to-video'
      duration: '10' (10 seconds)
      resolution: '1080p'
      Returns: taskId
    |
    v
    withRetry(pollWanJob(taskId), 2 attempts, 15s delay):
      GET -> kie.ai/api/v1/jobs/recordInfo?taskId={taskId}
      Poll every 15s, timeout: 600s (10 min)
      |
      +-- state='success' -> get resultUrl
      +-- state='fail' -> check failMsg
      |     +-- NSFW? -> regenerateSafeImage() + retry
      |     +-- Other? -> throw error
      +-- timeout -> throw error
    |
    v
    downloadWanVideo(resultUrl) -> MP4 buffer
    |
    v
    Write MP4 -> tmpDir/scenes/scene_01_anim.mp4
    |
    v
    uploadSceneAnimation() -> Supabase Storage
    |
    v
    Supabase UPDATE -> scenes
      SET animation_url = storagePath
    |
    v
    calcAnimationCost() -> tracker.addCost()
    |
    v
  Wait 10 seconds (Wan rate limit)
    |
    v
(next scene)
    |
    v
+-- Failure ratio > 80%? ---- YES -> throw error, pipeline halts
|
| NO
v
Failed scenes:
  +-- NSFW rejection? -> regenerateSafeImage() + retry animation
  +-- Other failure? -> staticImageFallback()
      FFmpeg: still image -> 10s video with zoompan effect
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
Supabase UPDATE -> pipeline_state
  stage=5, status='completed'
    |
    v
END Stage 5
```

---

## STAGE 7 — VIDEO ASSEMBLY

```
START Stage 7
    |
    v
Supabase SELECT -> scenes
  WHERE task_id = {task_id}
  (loads image_url, animation_url, audio_url per scene)
    |
    v
Supabase SELECT -> youtube_seo
  WHERE task_id = {task_id}
    |
    v
getBgmPath() -> assets/bgm/kids_folk_01.mp3
  (null if file missing -- BGM skipped)
    |
    v
Determine scale filter:
  videoType='long'  -> scale=1280:720,crop=1280:720
  videoType='short' -> scale=1080:1920,crop=1080:1920
    |
    v
bgmOffset = 0 (tracks cumulative BGM position)
    |
    v
+===============================================+
|  PER-SCENE ASSEMBLY                            |
+================================================+
    |
    v
[For each scene]:
    |
    v
  Get paths:
    animPath  <- scenes.animation_url (MP4 clip)
    audioPath <- scenes.audio_url (MP3 voice, downloaded from Storage)
    sfxPath   <- getSfxPath(environment) (ambient loop)
    bgmPath   <- getBgmPath() (background music)
    |
    +-- Has animPath? --+
    |                    |
    | YES               | NO
    v                    v
    mergeClipWithAudio() stillImageToVideo()
                          (imagePath -> 10s video
                           with zoompan effect)
                           then mergeClipWithAudio()
    |
    v
  FFmpeg complex filter:
    Input 0: animation clip (stream_loop -1)
    Input 1: voice audio    -> volume=1.0
    Input 2: SFX loop       -> volume=0.3, trim to sceneDur
    Input 3: BGM at offset  -> volume=0.12, trim to sceneDur
    Video: scale + crop to target resolution
    Audio: amix 3 inputs -> [aout]
    Duration: max(clip_duration, audio_duration)
    |
    v
  Output: scene_01_final.mp4
  bgmOffset += sceneDuration
    |
    v
(next scene)
+================================================+
    |
    v
+===============================================+
|  CONCATENATION                                 |
+================================================+
    |
    v
Create concat.txt (FFmpeg concat demuxer input):
  file 'scene_01_final.mp4'
  file 'scene_02_final.mp4'
  ...
    |
    v
FFmpeg concat -> concat.mp4
+================================================+
    |
    v
+===============================================+
|  FINAL BGM OVERLAY                             |
+================================================+
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
+================================================+
    |
    v
+===============================================+
|  LOGO WATERMARK                                |
+================================================+
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
+================================================+
    |
    v
+===============================================+
|  END CARD                                      |
+================================================+
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
+================================================+
    |
    v
Upload final_video.mp4 -> Supabase Storage
    |
    v
Supabase INSERT -> video_output
  (FK -> pipeline_state.task_id, storage path, duration)
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
Supabase UPDATE -> pipeline_state
  stage=7, status='completed'
    |
    v
END Stage 7
```

---

## STAGE 8 — YOUTUBE UPLOAD (UNLISTED)

```
START Stage 8
    |
    v
Supabase SELECT -> video_output
  WHERE task_id = {task_id}
    |
    v
Supabase SELECT -> youtube_seo
  WHERE task_id = {task_id}
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
  If not -> PATCH to add     |
  Set categoryId=27          |
    |                         |
    +-------------------------+
    |
    v
youtubeUrl = "https://youtu.be/{youtubeVideoId}"
    |
    v
Supabase UPDATE -> video_output
  SET youtube_video_id, youtube_url
    |
    v
Supabase UPDATE -> pipeline_state
  stage=8, status='completed'
    |
    v
sendTelegramMessage():
  "{title}
   YouTube: {youtubeUrl}
   Duration: {duration}s
   UNLISTED -- ready for your review
   Publish manually via: node publish-video.mjs {task_id}"
    |
    v
END Stage 8

*** Publishing is manual: run publish-video.mjs ***
```

---

## STAGE ORDER

```
1B -> 2 -> 3 -> 6 -> 4 -> 5 -> 7 -> 8
 |    |    |    |    |    |    |    |
 |    |    |    |    |    |    |    +-- YouTube upload (unlisted)
 |    |    |    |    |    |    +------ Video assembly
 |    |    |    |    |    +---------- Animation (image-to-video)
 |    |    |    |    +-------------- Scene illustration
 |    |    |    +------------------ Voice generation (TTS)
 |    |    +---------------------- Character preparation
 |    +-------------------------- Script generation + approval
 +------------------------------- Story extraction

Note: TTS (Stage 6) runs BEFORE illustration (Stage 4).
      Publishing is manual via publish-video.mjs.
```

---

## DB SCHEMA (pipeline_state as FK hub)

```
pipeline_state (task_id PK)
    |
    +---> concepts         (FK task_id)
    +---> scenes           (FK task_id)  -- replaces scene_assets
    +---> episode_characters (FK task_id)
    +---> youtube_seo      (FK task_id)
    +---> video_output     (FK task_id)

Each stage reads from DB, writes to DB.
No in-memory state passing between stages.
```

---

## RESUME SUPPORT

```
launch-pipeline-from-story.mjs --task_id {existing_task_id}
    |
    v
Supabase SELECT -> pipeline_state WHERE task_id = {task_id}
    |
    v
Determine last completed stage
    |
    v
Skip all completed stages, resume from next stage
    |
    v
(pipeline continues normally)
```

---

## EXTERNAL SERVICES MAP

```
+---------------------+  +------------------+  +-----------------+
| Claude Sonnet 4.6   |  | Claude Haiku 4.5 |  | ElevenLabs v3   |
| Stage 2: script     |  | Stage 6: enhance |  | Stage 6: TTS    |
| Stage 2: regen scene|  | dialogue + tags   |  | Per-scene MP3   |
+---------------------+  +------------------+  | Emotion via tags|
                                                +-----------------+

+---------------------+  +------------------+  +-----------------+
| Gemini 3.1 Flash    |  | Wan 2.6 (kie.ai) |  | YouTube Data API|
| Stage 3: char refs  |  | Stage 5: animate |  | Stage 8: upload |
| Stage 4: scene imgs |  | Image -> 10s vid |  | (unlisted only) |
| 1:1 refs, 16:9/9:16|  | 1080p resolution |  +-----------------+
+---------------------+  +------------------+

+---------------------+  +------------------+
| Telegram Bot API    |  | Supabase         |
| Send: text, photo,  |  | DB: pipeline_    |
|   audio, buttons    |  |   state, concepts|
| Receive: callbacks, |  |   scenes, episode|
|   text replies      |  |   _characters,   |
| Stage 2,4,6,8       |  |   youtube_seo,   |
+---------------------+  |   video_output   |
                          | Storage: images, |
                          |   animations,    |
                          |   audio (MP3s)   |
                          +------------------+
```

---

## DATA FLOW SUMMARY

```
Stage 1B -> concepts table
Stage 2  -> scenes table, youtube_seo table
Stage 3  -> episode_characters table
Stage 6  -> scenes table (audio_url, enhanced_text)
Stage 4  -> scenes table (image_url)
Stage 5  -> scenes table (animation_url)
Stage 7  -> video_output table (final video path, storage URL)
Stage 8  -> video_output table (youtube_video_id, youtube_url)

All reads/writes go through Supabase DB.
Audio files uploaded to Supabase Storage (not just /tmp).
```

---

## APPROVAL GATES SUMMARY

```
BLOCKING (pipeline waits):
  Stage 2: Per-scene script approval   -> Telegram buttons
  Stage 4: Per-scene image approval    -> Telegram photo + buttons  (feedback mode)
  Stage 5: Per-scene animation approval-> Telegram video + buttons  (feedback mode)
  Stage 6: Per-scene voice approval    -> Telegram audio + buttons  (feedback mode)

NON-BLOCKING (pipeline continues):
  Stage 3: Character roster review     -> Telegram message  (feedback mode)
  Stage 7: Assembly review             -> Telegram message  (feedback mode)
  Stage 8: YouTube upload notification -> Telegram message

HALTING (pipeline crashes, manual restart with --task_id):
  Stage 3: Missing characters          -> Telegram message + throw error
```
