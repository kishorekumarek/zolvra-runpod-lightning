#!/usr/bin/env node
/**
 * trigger-pipeline-from-submission.mjs
 *
 * Called by Friday when a 🚀 PIPELINE_TRIGGER Telegram message arrives.
 * Fetches story from Supabase by submission ID, writes to temp file, launches pipeline.
 *
 * Usage:
 *   node scripts/trigger-pipeline-from-submission.mjs <id> <short|long>
 */

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: join(__dirname, '../.env') })

const [,, id, type] = process.argv

if (!id || !type) {
  console.error('Usage: node trigger-pipeline-from-submission.mjs <id> <short|long>')
  process.exit(1)
}

if (!['short', 'long'].includes(type)) {
  console.error('type must be "short" or "long"')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

console.log(`📥 Fetching submission ${id}...`)

const { data, error } = await supabase
  .from('story_submissions')
  .select('id, story_text, video_type, teasers_enabled, status')
  .eq('id', id)
  .single()

if (error || !data) {
  console.error('❌ Failed to fetch submission:', error?.message)
  process.exit(1)
}

if (data.status !== 'pending') {
  console.warn(`⚠️  Submission ${id} is already ${data.status} — skipping`)
  process.exit(0)
}

// Write story to temp file
const tmpDir = join(tmpdir(), 'zolvra-stories')
mkdirSync(tmpDir, { recursive: true })
const storyFile = join(tmpDir, `story-${id}.txt`)
writeFileSync(storyFile, data.story_text, 'utf8')
console.log(`📝 Story written to ${storyFile}`)

// Mark as running
await supabase
  .from('story_submissions')
  .update({ status: 'running' })
  .eq('id', id)

// Shorts can't have teasers — defensive, even though DB + API enforce it.
const teasersEnabled = type === 'long' && data.teasers_enabled === true

console.log(`🚀 Launching pipeline — type: ${type}${teasersEnabled ? ', teasers: yes' : ''}`)

const launcherPath = join(__dirname, 'launch-pipeline-from-story.mjs')
const teaserFlag = teasersEnabled ? ' --with-teasers' : ''
try {
  execSync(`node "${launcherPath}" "${storyFile}" ${type}${teaserFlag}`, {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
  })

  // Mark done
  await supabase
    .from('story_submissions')
    .update({ status: 'done' })
    .eq('id', id)

  console.log('✅ Pipeline completed')
} catch (err) {
  console.error('❌ Pipeline failed:', err.message)

  await supabase
    .from('story_submissions')
    .update({ status: 'failed' })
    .eq('id', id)

  process.exit(1)
}
