#!/usr/bin/env node
// scripts/test-connections.mjs — Test all 6 API connections
import 'dotenv/config';

const results = [];

function pass(api, detail = '') {
  results.push({ api, status: 'PASS', detail });
  console.log(`  ✅ ${api}${detail ? ' — ' + detail : ''}`);
}

function fail(api, error) {
  results.push({ api, status: 'FAIL', detail: error });
  console.log(`  ❌ ${api} — ${error}`);
}

// ── 1. Supabase ──────────────────────────────────────────────────────────────
async function testSupabase() {
  try {
    const { getSupabase } = await import('../lib/supabase.mjs');
    const sb = getSupabase();

    const { data, error } = await sb
      .from('pipeline_settings')
      .select('key')
      .limit(1);

    if (error) throw new Error(error.message);
    pass('Supabase', `Connected (${data?.length ?? 0} settings rows visible)`);
  } catch (err) {
    fail('Supabase', err.message);
  }
}

// ── 2. Google AI (Imagen) ────────────────────────────────────────────────────
async function testGoogleAI() {
  try {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');

    // Use a simple Gemini text endpoint to validate key (cheaper than imagen)
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    const data = await res.json();

    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    const models = (data.models || []).map(m => m.name);
    const hasImagen = models.some(m => m.includes('imagen') || m.includes('gemini'));
    pass('Google AI', `Key valid, ${models.length} models listed${hasImagen ? ', Imagen/Gemini found' : ''}`);
  } catch (err) {
    fail('Google AI', err.message);
  }
}

// ── 3. kie.ai (Kling) ───────────────────────────────────────────────────────
async function testKieAI() {
  try {
    const apiKey = process.env.KIEAI_API_KEY;
    if (!apiKey) throw new Error('KIEAI_API_KEY not set');

    // Check account info endpoint
    const res = await fetch('https://api.kie.ai/v1/account', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 404) {
      // Endpoint may not exist — try videos list
      const res2 = await fetch('https://api.kie.ai/v1/videos/image2video?page=1&pageSize=1', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res2.status === 401) throw new Error('Invalid API key');
      pass('kie.ai (Kling)', `Key accepted (HTTP ${res2.status})`);
      return;
    }

    const data = await res.json();
    pass('kie.ai (Kling)', `Key valid${data?.data?.credits ? `, credits: ${data.data.credits}` : ''}`);
  } catch (err) {
    fail('kie.ai (Kling)', err.message);
  }
}

// ── 4. ElevenLabs ───────────────────────────────────────────────────────────
async function testElevenLabs() {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': apiKey },
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail?.message || `HTTP ${res.status}`);

    const charUsed = data.subscription?.character_count || 0;
    const charLimit = data.subscription?.character_limit || 0;
    pass('ElevenLabs', `Key valid, chars: ${charUsed}/${charLimit}`);
  } catch (err) {
    fail('ElevenLabs', err.message);
  }
}

// ── 5. YouTube ───────────────────────────────────────────────────────────────
async function testYouTube() {
  try {
    const { getChannelInfo } = await import('../lib/youtube.mjs');
    const channel = await getChannelInfo();

    if (!channel) throw new Error('No channel found for authenticated account');
    const name = channel.snippet?.title || 'Unknown';
    const subs = channel.statistics?.subscriberCount || '?';
    pass('YouTube', `Channel: "${name}", subscribers: ${subs}`);
  } catch (err) {
    fail('YouTube', err.message);
  }
}

// ── 6. Pixabay ───────────────────────────────────────────────────────────────
async function testPixabay() {
  try {
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) throw new Error('PIXABAY_API_KEY not set');

    const res = await fetch(
      `https://pixabay.com/api/?key=${apiKey}&q=kids+happy&media_type=music&per_page=3&safesearch=true`
    );
    const data = await res.json();

    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    if (data.error) throw new Error(data.error);

    pass('Pixabay', `Key valid, ${data.totalHits || 0} music tracks available`);
  } catch (err) {
    fail('Pixabay', err.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔌 Testing API connections...\n');

  await testSupabase();
  await testGoogleAI();
  await testKieAI();
  await testElevenLabs();
  await testYouTube();
  await testPixabay();

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Result: ${passed}/${results.length} APIs connected`);

  if (failed > 0) {
    console.log(`\n⚠️  Failed APIs:`);
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`   ${r.api}: ${r.detail}`);
    });
    process.exit(1);
  } else {
    console.log(`\n🎉 All APIs connected successfully!`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
