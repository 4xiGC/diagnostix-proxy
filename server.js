// DiagnostiX API Proxy — Railway Server
// This is a simple Express server that runs on Railway
// No firewall restrictions, no domain blocking

import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies
app.use(express.json());

// Allow requests from any origin (your Wix page)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Health check — visiting the URL in a browser shows this
app.get('/', (req, res) => {
  res.json({ status: 'DiagnostiX proxy is running', version: '1.0' });
});

// Main endpoint — receives survey data, runs searches, returns report
app.post('/diagnose', async (req, res) => {

  const body = req.body;
  if (!body || !body.name) {
    return res.status(400).json({ error: 'Restaurant name is required' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SERPER_KEY    = process.env.SERPER_API_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Railway environment variables' });
  if (!SERPER_KEY)    return res.status(500).json({ error: 'SERPER_API_KEY not set in Railway environment variables' });

  const name     = String(body.name || '');
  const location = String(body.location || '');
  const s        = body.sentiment || {};

  // ── Run Serper web searches ───────────────────────────────────
  async function search(query) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY':     SERPER_KEY,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ q: query, num: 5 })
      });
      const d = await r.json();
      let out = '';
      if (d.knowledgeGraph) {
        const kg = d.knowledgeGraph;
        out += `[Google] ${kg.title || ''} | Rating: ${kg.rating || 'N/A'} (${kg.reviewCount || '0'} reviews) | ${kg.description || ''}\n`;
      }
      (d.organic || []).slice(0, 4).forEach(i => {
        out += `• ${i.title}: ${i.snippet || ''}\n`;
      });
      return out || 'No data found';
    } catch (e) {
      return `Search error: ${e.message}`;
    }
  }

  // Run all 6 searches in parallel for speed
  const [googleData, reviewData, staffData, socialData, deliveryData, competitorData] = await Promise.all([
    search(`"${name}" ${location} restaurant`),
    search(`"${name}" ${location} reviews TripAdvisor Yelp OpenTable rating`),
    search(`"${name}" Glassdoor Indeed staff employees`),
    search(`"${name}" Instagram Facebook social media followers`),
    search(`"${name}" Uber Eats DoorDash delivery online ordering`),
    search(`best restaurants ${location} similar ${name} competitors`)
  ]);

  const webData = `GOOGLE: ${googleData}\nREVIEWS: ${reviewData}\nSTAFF: ${staffData}\nSOCIAL: ${socialData}\nDELIVERY: ${deliveryData}\nCOMPETITORS: ${competitorData}`;

  const surveyStr = `perf=${s.perf||5} cap=${s.cap||5} ret=${s.ret||5} amb=${s.amb||5} repeat=${s.repeat||5} book=${s.book||5} menu=${s.menu||5} online=${s.online||5} price=${s.price||5} future=${s.future||5}`;

  // ── Call Claude to generate the report ───────────────────────
  async function callClaude(userMsg) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system:     'You are a JSON API. Respond with ONLY a valid JSON object. No markdown. No backticks. No text before or after the JSON. Start with { and end with }.',
        messages:   [{ role: 'user', content: userMsg }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // Try multiple JSON extraction strategies
    try { return JSON.parse(text); } catch(e) {}
    try {
      const start = text.indexOf('{');
      const end   = text.lastIndexOf('}');
      if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    } catch(e) {}
    throw new Error('JSON parse failed: ' + text.slice(0, 200));
  }

  // ── Two smaller Claude calls to avoid token limits ────────────

  // Call 1: Scores and summary
  let part1;
  try {
    part1 = await callClaude(
      `Restaurant: ${name}, Location: ${location}\n` +
      `Owner survey (1-10): ${surveyStr}\n` +
      `Web data:\n${webData.slice(0, 2500)}\n\n` +
      `Return this JSON with real data from the web search above:\n` +
      `{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"detected from data","priceDetected":"$$","executiveSummary":"2-3 sentences mentioning real ratings and review counts found","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real rating and review count"},{"name":"Yelp","score":65,"note":"real data or not found"},{"name":"TripAdvisor","score":55,"note":"real data or not found"},{"name":"OpenTable / Resy","score":60,"note":"real data or not found"},{"name":"Social Media","score":50,"note":"real follower count or not found"},{"name":"Delivery Platforms","score":35,"note":"platforms found or not listed"}]},"ownerSentimentSummary":"2 sentences comparing survey to web data","sentimentGap":"key difference between owner perception and reality"}\n` +
      `Rules: good>=65 warn 45-64 bad<45. scoreVerdict=Excellent/Good/Fair/Needs Attention`
    );
  } catch(e) {
    return res.status(500).json({ error: 'Part 1 failed: ' + e.message });
  }

  // Call 2: Insights, actions and verbatims
  let part2;
  try {
    part2 = await callClaude(
      `Restaurant: ${name}, Location: ${location}\n` +
      `Web data:\n${webData.slice(0, 2500)}\n\n` +
      `Return this JSON with real data from web search above:\n` +
      `{"reviewVerbatims":[{"text":"real customer quote from web data","source":"Google","stars":5,"sentiment":"positive"},{"text":"real customer quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real customer quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real customer quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["specific strength with evidence","strength 2","strength 3"],"risks":["specific risk with evidence","risk 2","risk 3"],"themes":{"positive":["theme1","theme2","theme3"],"negative":["theme1","theme2"],"neutral":["theme1","theme2"]},"employeeSentiment":"Glassdoor/Indeed findings or no data found","competitiveInsight":"competitive landscape from search results","competitors":[{"name":"real competitor","score":68,"note":"brief data"},{"name":"real competitor","score":62,"note":"brief data"},{"name":"real competitor","score":71,"note":"brief data"}],"actions":[{"priority":"urgent","title":"action title","desc":"evidence-based action from web data"},{"priority":"urgent","title":"action title","desc":"evidence-based action"},{"priority":"30days","title":"action title","desc":"action"},{"priority":"30days","title":"action title","desc":"action"},{"priority":"ongoing","title":"action title","desc":"action"}]}`
    );
  } catch(e) {
    return res.status(500).json({ error: 'Part 2 failed: ' + e.message });
  }

  // Merge both parts
  const report = Object.assign({}, part1, part2);

  if (!report.healthCheckScore || !report.pillars) {
    return res.status(500).json({
      error:      'Report missing required fields',
      keys:       Object.keys(report),
      hasScore:   !!report.healthCheckScore,
      hasPillars: !!report.pillars
    });
  }

  return res.status(200).json(report);
});

app.listen(PORT, () => {
  console.log(`DiagnostiX proxy running on port ${PORT}`);
});

