// DiagnostiX — Railway Server
// Serves BOTH the HTML tool (as a webpage) AND the /diagnose API
// No iframe sandbox issues — the HTML and API are on the same domain

import express from 'express';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app  = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json());

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ── Serve the DiagnostiX HTML tool as the homepage ───────────
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.json({ status: 'DiagnostiX proxy running', version: '2.0', note: 'HTML page not found - check public/index.html exists' });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'DiagnostiX proxy is running', version: '2.0' });
});

// ── Serper search helper ─────────────────────────────────────
async function search(query, serperKey) {
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 })
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

// ── Claude call helper ───────────────────────────────────────
async function callClaude(userMsg, anthropicKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: 'You are a JSON API. Respond with ONLY a valid JSON object. No markdown. No backticks. No text before or after. Start with { end with }.',
      messages: [{ role: 'user', content: userMsg }]
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

// ── Main API endpoint ────────────────────────────────────────
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
  const surveyStr = `perf=${s.perf||5} cap=${s.cap||5} ret=${s.ret||5} amb=${s.amb||5} repeat=${s.repeat||5} book=${s.book||5} menu=${s.menu||5} online=${s.online||5} price=${s.price||5} future=${s.future||5}`;

  // Run 6 searches in parallel
  const [googleData, reviewData, staffData, socialData, deliveryData, competitorData] = await Promise.all([
    search(`"${name}" ${location} restaurant`, SERPER_KEY),
    search(`"${name}" ${location} reviews TripAdvisor Yelp OpenTable rating`, SERPER_KEY),
    search(`"${name}" Glassdoor Indeed staff employees`, SERPER_KEY),
    search(`"${name}" Instagram Facebook social media followers`, SERPER_KEY),
    search(`"${name}" Uber Eats DoorDash delivery`, SERPER_KEY),
    search(`best restaurants ${location} similar ${name} competitors`, SERPER_KEY)
  ]);

  const webData = `GOOGLE: ${googleData}\nREVIEWS: ${reviewData}\nSTAFF: ${staffData}\nSOCIAL: ${socialData}\nDELIVERY: ${deliveryData}\nCOMPETITORS: ${competitorData}`;

  // Call 1: Scores
  let part1;
  try {
    part1 = await callClaude(
      `Restaurant: ${name}, Location: ${location}\nOwner survey: ${surveyStr}\nWeb data:\n${webData.slice(0,2500)}\n\n` +
      `Return JSON with scores using real data found:\n` +
      `{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"detected","priceDetected":"$$","executiveSummary":"2-3 sentences with real ratings","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real data"},{"name":"Yelp","score":65,"note":"real data"},{"name":"TripAdvisor","score":55,"note":"real data"},{"name":"OpenTable","score":60,"note":"real data"},{"name":"Social Media","score":50,"note":"real data"},{"name":"Delivery Platforms","score":35,"note":"real data"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence"}\n` +
      `Rules: good>=65 warn 45-64 bad<45. scoreVerdict=Excellent/Good/Fair/Needs Attention`,
      ANTHROPIC_KEY
    );
  } catch(e) {
    return res.status(500).json({ error: 'Part 1 failed: ' + e.message });
  }

  // Call 2: Insights
  let part2;
  try {
    part2 = await callClaude(
      `Restaurant: ${name}, Location: ${location}\nWeb data:\n${webData.slice(0,2500)}\n\n` +
      `Return JSON with insights using real data:\n` +
      `{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["evidence-based strength 1","strength 2","strength 3"],"risks":["evidence-based risk 1","risk 2","risk 3"],"themes":{"positive":["theme1","theme2","theme3"],"negative":["theme1","theme2"],"neutral":["theme1","theme2"]},"employeeSentiment":"Glassdoor/Indeed findings","competitiveInsight":"competitive landscape","competitors":[{"name":"real competitor","score":68,"note":"data"},{"name":"real competitor","score":62,"note":"data"},{"name":"real competitor","score":71,"note":"data"}],"actions":[{"priority":"urgent","title":"action","desc":"evidence-based"},{"priority":"urgent","title":"action","desc":"desc"},{"priority":"30days","title":"action","desc":"desc"},{"priority":"30days","title":"action","desc":"desc"},{"priority":"ongoing","title":"action","desc":"desc"}]}`,
      ANTHROPIC_KEY
    );
  } catch(e) {
    return res.status(500).json({ error: 'Part 2 failed: ' + e.message });
  }

  const report = Object.assign({}, part1, part2);

  if (!report.healthCheckScore || !report.pillars) {
    return res.status(500).json({ error: 'Missing required fields', keys: Object.keys(report) });
  }

  return res.status(200).json(report);
});

app.listen(PORT, () => {
  console.log(`DiagnostiX running on port ${PORT}`);
});
