# Kling API Notes (Updated March 2026)

## Endpoint
POST https://api.kie.ai/api/v1/jobs/createTask

## Auth
Authorization: Bearer {KIEAI_API_KEY}

## Query Task
GET https://api.kie.ai/api/v1/jobs/queryTask/{taskId}

## Response format
{ code: 200, data: { taskId, state, resultJson: '{"resultUrls":["..."]}' } }

## Known working models
- `kling-3.0/motion-control` — needs input_urls + video_urls (NOT what we want)
- `kling/ai-avatar-standard` — needs image_url + audio_url (avatar product)
- `kling/ai-avatar-pro` — needs image_url + audio_url (avatar product)

## TODO
- Find correct model name for plain image-to-video (kling/image-to-video returns 422)
- Check docs.kie.ai → Kling → Image to Video section for the example cURL
