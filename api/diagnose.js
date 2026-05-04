// DiagnostiX — Vercel Proxy with Serper web search
// Place this file at: api/diagnose.js in your GitHub repo

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  if (!body || !body.name) return res.status(400).json({ error: 'Restaurant name is required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const serperKey    = process.env.SERPER_API_KEY;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!serperKey)    return res.status(500).json({ error: 'SERPER_API_KEY not configured' });

  const name     = body.name;
  const location = body.location || '';
  const s        = body.sentiment || {};

  // ── Step 1: Run Serper searches ──────────────────────────────
  async function serperSearch(query) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' })
      });
      const d = await r.json();
      const kg = d.knowledgeGraph
        ? `[Knowledge Graph] ${d.knowledgeGraph.title || ''} | Rating: ${d.knowledgeGraph.rating || 'N/A'} | Reviews: ${d.knowledgeGraph.reviewCount || 'N/A'} | ${d.knowledgeGraph.description || ''}`
        : '';
      const organic = (d.organic || []).slice(0, 6).map(item =>
        `- ${item.title}: ${item.snippet || ''}`
      ).join('\n');
      return [kg, organic].filter(Boolean).join('\n');
    } catch (e) {
      return `Search unavailable: ${e.message}`;
    }
  }

  // Run all searches in parallel
  const [reviews, tripadvisor, employees, social, delivery, competitors] = await Promise.all([
    serperSearch(`"${name}" ${location} restaurant reviews Google rating`),
    serperSearch(`"${name}" ${location} TripAdvisor Yelp OpenTable`),
    serperSearch(`"${name}" ${location} Glassdoor Indeed staff employees`),
    serperSearch(`"${name}" Instagram Facebook social media`),
    serperSearch(`"${name}" Uber Eats DoorDash Rappi delivery`),
    serperSearch(`best restaurants ${location} ${name} competitors similar`)
  ]);

  const webData = `GOOGLE REVIEWS:\n${reviews}\n\nTRIPADVISOR/YELP:\n${tripadvisor}\n\nEMPLOYEES:\n${employees}\n\nSOCIAL MEDIA:\n${social}\n\nDELIVERY:\n${delivery}\n\nCOMPETITORS:\n${competitors}`;

  // ── Step 2: Claude generates report from web data ────────────
  const prompt = `You are DiagnostiX by 4xi. Analyse the web data below and generate a restaurant HealthCheck JSON report.

RESTAURANT: ${name}
LOCATION: ${location}
WEBSITE: ${body.website || 'not provided'}

OWNER SURVEY (1-10): performance=${s.perf||5}, capacity=${s.cap||5}, retention=${s.ret||5}, ambiance=${s.amb||5}, repeat=${s.repeat||5}, bookings=${s.book||5}, menu=${s.menu||5}, online=${s.online||5}, pricing=${s.price||5}, optimism=${s.future||5}

WEB DATA FOUND:
${webData}

Generate a detailed report using the web data above. Extract real ratings, review counts, quotes.

YOU MUST RESPOND WITH ONLY THE JSON OBJECT BELOW. NO TEXT BEFORE OR AFTER IT. NO MARKDOWN. NO BACKTICKS.

{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"from data","priceDetected":"$$","executiveSummary":"2-3 sentences using real data found above including actual ratings","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real data e.g. 4.3 stars 284 reviews"},{"name":"Yelp","score":65,"note":"data found or not listed"},{"name":"TripAdvisor","score":55,"note":"data found or not listed"},{"name":"OpenTable / Resy","score":60,"note":"data found or not listed"},{"name":"Social Media","score":50,"note":"e.g. 2.1k Instagram followers"},{"name":"Delivery Platforms","score":35,"note":"listed or not listed"}]},"ownerSentimentSummary":"2 sentences comparing survey scores to web data","sentimentGap":"what differs between owner perception and market reality","reviewVerbatims":[{"text":"real quote from web data","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote from web data","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote from web data","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote from web data","source":"Google","stars":3,"sentiment":"negative"}],"strengths":["evidence-based strength 1","strength 2","strength 3"],"risks":["evidence-based risk 1","risk 2","risk 3"],"themes":{"positive":["theme1","theme2","theme3"],"negative":["theme1","theme2"],"neutral":["theme1","theme2"]},"employeeSentiment":"Glassdoor/Indeed findings or no data found","competitiveInsight":"competitive landscape from search results","competitors":[{"name":"real competitor","score":68,"note":"data found"},{"name":"real competitor","score":62,"note":"data found"},{"name":"real competitor","score":71,"note":"data found"}],"actions":[{"priority":"urgent","title":"action title","desc":"specific evidence-based action"},{"priority":"urgent","title":"action title","desc":"specific action"},{"priority":"30days","title":"action title","desc":"specific action"},{"priority":"30days","title":"action title","desc":"specific action"},{"priority":"ongoing","title":"action title","desc":"specific action"}]}`;

  let claudeData;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: 'You are a JSON API. You must respond with ONLY a valid JSON object. No markdown, no backticks, no text before or after the JSON. Your entire response must start with { and end with } and be parseable by JSON.parse().',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    claudeData = await claudeRes.json();
  } catch (e) {
    return res.status(500).json({ error: 'Claude fetch failed: ' + String(e) });
  }

  if (claudeData.error) {
    return res.status(500).json({ error: 'Claude error: ' + claudeData.error.message });
  }

  // Extract text from response
  const rawText = (claudeData.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  if (!rawText) {
    return res.status(500).json({ error: 'Empty response from Claude', stopReason: claudeData.stop_reason });
  }

  // ── Robust JSON extraction ───────────────────────────────────
  // Try multiple strategies to extract valid JSON
  let report = null;
  const strategies = [
    // 1. Direct parse of trimmed text
    () => JSON.parse(rawText.trim()),
    // 2. Strip markdown fences
    () => JSON.parse(rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()),
    // 3. Extract first {...} block
    () => {
      const m = rawText.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('no match');
      return JSON.parse(m[0]);
    },
    // 4. Find the largest {...} block
    () => {
      const matches = rawText.match(/\{[\s\S]*?\}/g) || [];
      const largest = matches.sort((a, b) => b.length - a.length)[0];
      if (!largest) throw new Error('no block');
      return JSON.parse(largest);
    }
  ];

  for (const strategy of strategies) {
    try {
      report = strategy();
      if (report && report.healthCheckScore) break;
    } catch (e) {
      continue;
    }
  }

  if (!report) {
    // Return the raw text so we can debug
    return res.status(500).json({
      error: 'JSON parsing failed after all strategies',
      rawPreview: rawText.slice(0, 600),
      rawLength: rawText.length
    });
  }

  return res.status(200).json(report);
}
