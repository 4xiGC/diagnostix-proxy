// DiagnostiX — Railway Server v3
// Added /test endpoint to diagnose API key issues

import express from 'express';
// Using native fetch (Node 18+)
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app  = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Serve HTML page
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.json({ status: 'DiagnostiX running', version: '3.0', error: 'index.html not found: ' + e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'DiagnostiX proxy is running', version: '3.0' });
});

// ── TEST ENDPOINT ─────────────────────────────────────────────
// Visit https://diagnostix-proxy-production.up.railway.app/test
// This tells you exactly what keys are loaded and whether they work
app.get('/test', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SERPER_KEY    = process.env.SERPER_API_KEY;

  const result = {
    anthropic_key_present: !!ANTHROPIC_KEY,
    anthropic_key_prefix:  ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0, 20) + '...' : 'MISSING',
    anthropic_key_length:  ANTHROPIC_KEY ? ANTHROPIC_KEY.length : 0,
    serper_key_present:    !!SERPER_KEY,
    serper_key_prefix:     SERPER_KEY ? SERPER_KEY.slice(0, 10) + '...' : 'MISSING',
  };

  // Test Anthropic API with minimal call
  if (ANTHROPIC_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages:   [{ role: 'user', content: 'Say OK' }]
        })
      });
      const data = await r.json();
      result.anthropic_test_status = r.status;
      if (data.error) {
        result.anthropic_test_result = 'FAILED: ' + data.error.message;
        result.anthropic_error_type  = data.error.type;
      } else {
        result.anthropic_test_result = 'SUCCESS - API key is valid';
      }
    } catch(e) {
      result.anthropic_test_result = 'ERROR: ' + e.message;
    }
  }

  // Test Serper
  if (SERPER_KEY) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method:  'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ q: 'test', num: 1 })
      });
      const data = await r.json();
      result.serper_test_status = r.status;
      result.serper_test_result = r.status === 200 ? 'SUCCESS - Serper key is valid' : 'FAILED: ' + JSON.stringify(data).slice(0, 100);
    } catch(e) {
      result.serper_test_result = 'ERROR: ' + e.message;
    }
  }

  res.json(result);
});

// ── Serper search helper ──────────────────────────────────────
async function search(query, serperKey) {
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: query, num: 5 })
    });
    const d = await r.json();
    let out = '';
    if (d.knowledgeGraph) {
      const kg = d.knowledgeGraph;
      out += `[Google] ${kg.title||''} | Rating: ${kg.rating||'N/A'} (${kg.reviewCount||'0'} reviews) | ${kg.description||''}\n`;
    }
    (d.organic||[]).slice(0,4).forEach(i => { out += `• ${i.title}: ${i.snippet||''}\n`; });
    return out || 'No data found';
  } catch(e) {
    return `Search error: ${e.message}`;
  }
}

// ── Claude call helper ────────────────────────────────────────
async function callClaude(userMsg, anthropicKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     'You are a JSON API. Respond with ONLY a valid JSON object. No markdown. No backticks. No text before or after. Start with { end with }.',
      messages:   [{ role: 'user', content: userMsg }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  try { return JSON.parse(text); } catch(e) {}
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end+1));
  throw new Error('JSON parse failed: ' + text.slice(0,200));
}

// ── Main API endpoint ─────────────────────────────────────────
app.post('/diagnose', async (req, res) => {
  const body = req.body;
  if (!body || !body.name) return res.status(400).json({ error: 'Restaurant name is required' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SERPER_KEY    = process.env.SERPER_API_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!SERPER_KEY)    return res.status(500).json({ error: 'SERPER_API_KEY not configured' });

  const name     = String(body.name || '');
  const location = String(body.location || '');
  const s        = body.sentiment || {};
  const survey   = `perf=${s.perf||5} cap=${s.cap||5} ret=${s.ret||5} amb=${s.amb||5} repeat=${s.repeat||5} book=${s.book||5} menu=${s.menu||5} online=${s.online||5} price=${s.price||5} future=${s.future||5}`;

  console.log(`[diagnose] Starting for: ${name} in ${location}`);
  console.log(`[diagnose] ANTHROPIC_KEY present: ${!!ANTHROPIC_KEY}, length: ${ANTHROPIC_KEY?.length}`);
  console.log(`[diagnose] SERPER_KEY present: ${!!SERPER_KEY}`);

  // Run 6 searches in parallel
  const [g, r2, st, so, d, c] = await Promise.all([
    search(`"${name}" ${location} restaurant`, SERPER_KEY),
    search(`"${name}" ${location} reviews TripAdvisor Yelp OpenTable`, SERPER_KEY),
    search(`"${name}" Glassdoor Indeed employees`, SERPER_KEY),
    search(`"${name}" Instagram Facebook social media`, SERPER_KEY),
    search(`"${name}" Uber Eats DoorDash delivery`, SERPER_KEY),
    search(`best restaurants ${location} competitors similar ${name}`, SERPER_KEY)
  ]);

  const webData = `GOOGLE:${g}\nREVIEWS:${r2}\nSTAFF:${st}\nSOCIAL:${so}\nDELIVERY:${d}\nCOMPETITORS:${c}`;
  console.log(`[diagnose] Searches complete. webData length: ${webData.length}`);
  console.log(`[diagnose] Google snippet: ${g.slice(0,100)}`);

  // Part 1: Scores
  let part1;
  console.log('[diagnose] Calling Claude Part 1...');
  try {
    part1 = await callClaude(
      `Restaurant: ${name}, Location: ${location}\nSurvey: ${survey}\nWeb data:\n${webData.slice(0,2500)}\n\n` +
      `Return JSON scores using real data:\n` +
      `{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"detected","priceDetected":"$$","executiveSummary":"2-3 sentences with real data","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real data"},{"name":"Yelp","score":65,"note":"real data"},{"name":"TripAdvisor","score":55,"note":"real data"},{"name":"OpenTable","score":60,"note":"real data"},{"name":"Social Media","score":50,"note":"real data"},{"name":"Delivery Platforms","score":35,"note":"real data"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence"}\n` +
      `Rules: good>=65 warn 45-64 bad<45`,
      ANTHROPIC_KEY
    );
  } catch(e) {
    console.error('[diagnose] Part1 FAILED:', e.message);
    return res.status(500).json({ error: 'Part1: ' + e.message });
  }
  console.log('[diagnose] Part1 success. Score:', part1?.healthCheckScore);

  // Part 2: Insights
  let part2;
  console.log('[diagnose] Calling Claude Part 2...');
  try {
    part2 = await callClaude(
      `Restaurant: ${name}, Location: ${location}\nWeb data:\n${webData.slice(0,2500)}\n\n` +
      `Return JSON insights:\n` +
      `{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["strength with evidence","strength","strength"],"risks":["risk with evidence","risk","risk"],"themes":{"positive":["t1","t2","t3"],"negative":["t1","t2"],"neutral":["t1","t2"]},"employeeSentiment":"findings","competitiveInsight":"landscape","competitors":[{"name":"competitor","score":68,"note":"data"},{"name":"competitor","score":62,"note":"data"},{"name":"competitor","score":71,"note":"data"}],"actions":[{"priority":"urgent","title":"title","desc":"evidence-based"},{"priority":"urgent","title":"title","desc":"desc"},{"priority":"30days","title":"title","desc":"desc"},{"priority":"30days","title":"title","desc":"desc"},{"priority":"ongoing","title":"title","desc":"desc"}]}`,
      ANTHROPIC_KEY
    );
  } catch(e) {
    console.error('[diagnose] Part2 FAILED:', e.message);
    return res.status(500).json({ error: 'Part2: ' + e.message });
  }
  console.log('[diagnose] Part2 success. Actions:', part2?.actions?.length);

  const report = Object.assign({}, part1, part2);
  if (!report.healthCheckScore || !report.pillars) {
    return res.status(500).json({ error: 'Missing fields', keys: Object.keys(report) });
  }

  console.log('[diagnose] SUCCESS. Returning report with score:', report.healthCheckScore);
  return res.status(200).json(report);
});

app.listen(PORT, () => console.log(`DiagnostiX on port ${PORT}`));
