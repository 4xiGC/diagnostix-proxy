// DiagnostiX Vercel Proxy - Clean Version
// File: api/diagnose.js

export default async function handler(req, res) {

  // CORS headers - must be first
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Read request body ---
  const body = req.body;
  if (!body || !body.name) {
    return res.status(400).json({ error: 'Restaurant name is required' });
  }

  // --- Check API keys ---
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing from Vercel environment variables' });
  }
  if (!SERPER_KEY) {
    return res.status(500).json({ error: 'SERPER_API_KEY missing from Vercel environment variables' });
  }

  const name = String(body.name || '');
  const location = String(body.location || '');
  const website = String(body.website || 'not provided');
  const competitors = String(body.competitors || 'none');
  const s = body.sentiment || {};

  // --- Run Serper web searches ---
  async function search(query) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': SERPER_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, num: 6 })
      });
      const data = await r.json();

      let output = '';

      // Knowledge graph (Google's info box)
      if (data.knowledgeGraph) {
        const kg = data.knowledgeGraph;
        output += `Google Info: ${kg.title || ''} | ${kg.type || ''} | Rating: ${kg.rating || 'N/A'} (${kg.reviewCount || '0'} reviews) | ${kg.description || ''}\n`;
        if (kg.attributes) {
          Object.entries(kg.attributes).forEach(([k, v]) => {
            output += `  ${k}: ${v}\n`;
          });
        }
      }

      // Organic results
      if (data.organic) {
        data.organic.slice(0, 5).forEach(item => {
          output += `• ${item.title}: ${item.snippet || ''}\n`;
        });
      }

      return output || 'No results found';
    } catch (err) {
      return `Search error: ${err.message}`;
    }
  }

  // Run all 6 searches in parallel
  const [
    googleData,
    reviewSites,
    staffData,
    socialData,
    deliveryData,
    competitorData
  ] = await Promise.all([
    search(`"${name}" ${location} restaurant`),
    search(`"${name}" ${location} reviews TripAdvisor Yelp OpenTable rating stars`),
    search(`"${name}" ${location} staff employees Glassdoor Indeed work`),
    search(`"${name}" restaurant Instagram Facebook followers social media`),
    search(`"${name}" Uber Eats DoorDash delivery online ordering`),
    search(`best restaurants ${location} similar ${name}`)
  ]);

  const webContext = `
GOOGLE BUSINESS DATA:
${googleData}

REVIEWS (TripAdvisor/Yelp/OpenTable):
${reviewSites}

STAFF & EMPLOYEE DATA (Glassdoor/Indeed):
${staffData}

SOCIAL MEDIA (Instagram/Facebook):
${socialData}

DELIVERY PLATFORMS:
${deliveryData}

LOCAL COMPETITORS:
${competitorData}
`.trim();

  // --- Build Claude prompt ---
  const surveyScores = `
Overall business performance: ${s.perf || 5}/10
Customer volume vs capacity: ${s.cap || 5}/10
Staff retention: ${s.ret || 5}/10
Ambiance & venue condition: ${s.amb || 5}/10
Repeat customers: ${s.repeat || 5}/10
Advance bookings: ${s.book || 5}/10
Menu strength: ${s.menu || 5}/10
Online presence: ${s.online || 5}/10
Pricing vs value: ${s.price || 5}/10
12-month optimism: ${s.future || 5}/10`.trim();

  const systemPrompt = `You are DiagnostiX, a restaurant performance intelligence platform by 4xi. 
You respond ONLY with a single valid JSON object. 
No text before the JSON. No text after the JSON. No markdown. No backticks.
Your response must begin with { and end with }`;

  const userPrompt = `Analyse this restaurant using the web data provided and generate a HealthCheck report.

RESTAURANT: ${name}
LOCATION: ${location}
WEBSITE: ${website}
COMPETITORS NAMED: ${competitors}

OWNER SURVEY SCORES (1-10):
${surveyScores}

WEB DATA FROM LIVE SEARCHES:
${webContext}

Using the web data above, return this JSON structure filled with real data:

{
  "healthCheckScore": 72,
  "scoreVerdict": "Good",
  "cuisineDetected": "detected cuisine from web data",
  "priceDetected": "price range detected",
  "executiveSummary": "Write 2-3 sentences using REAL data found above - mention actual star ratings and review counts if found",
  "pillars": {
    "cs": {"score": 75, "label": "Customer Sentiment", "status": "good"},
    "pa": {"score": 65, "label": "Pricing & Accessibility", "status": "good"},
    "es": {"score": 48, "label": "Employee Sentiment", "status": "warn"},
    "sm": {"score": 55, "label": "Social Media Impact", "status": "warn"},
    "cp": {"score": 70, "label": "Competitive Positioning", "status": "good"},
    "bg": {"score": 68, "label": "Brand Experience & Growth", "status": "good"}
  },
  "onlinePresence": {
    "overall": 62,
    "channels": [
      {"name": "Google Business", "score": 80, "note": "insert real rating and review count found"},
      {"name": "Yelp", "score": 65, "note": "insert real data or not found"},
      {"name": "TripAdvisor", "score": 55, "note": "insert real data or not found"},
      {"name": "OpenTable / Resy", "score": 60, "note": "insert real data or not found"},
      {"name": "Social Media", "score": 50, "note": "insert real follower count or not found"},
      {"name": "Delivery Platforms", "score": 35, "note": "insert platforms found or not listed"}
    ]
  },
  "ownerSentimentSummary": "2 sentences interpreting owner survey vs market data",
  "sentimentGap": "Key difference between owner perception and market reality",
  "reviewVerbatims": [
    {"text": "real customer quote from web data", "source": "Google", "stars": 5, "sentiment": "positive"},
    {"text": "real customer quote from web data", "source": "TripAdvisor", "stars": 4, "sentiment": "positive"},
    {"text": "real customer quote from web data", "source": "Yelp", "stars": 3, "sentiment": "negative"},
    {"text": "real customer quote from web data", "source": "Google", "stars": 2, "sentiment": "negative"}
  ],
  "strengths": [
    "Specific strength with evidence from web data",
    "Specific strength with evidence",
    "Specific strength with evidence"
  ],
  "risks": [
    "Specific risk with evidence from web data",
    "Specific risk with evidence",
    "Specific risk with evidence"
  ],
  "themes": {
    "positive": ["theme from reviews", "theme", "theme"],
    "negative": ["theme from reviews", "theme"],
    "neutral": ["theme", "theme"]
  },
  "employeeSentiment": "What Glassdoor/Indeed data shows, or state if not found",
  "competitiveInsight": "Competitive landscape based on search results",
  "competitors": [
    {"name": "Real competitor name from search", "score": 68, "note": "brief note"},
    {"name": "Real competitor name from search", "score": 62, "note": "brief note"},
    {"name": "Real competitor name from search", "score": 71, "note": "brief note"}
  ],
  "actions": [
    {"priority": "urgent", "title": "Specific action title", "desc": "Evidence-based recommendation from web data"},
    {"priority": "urgent", "title": "Specific action title", "desc": "Evidence-based recommendation"},
    {"priority": "30days", "title": "Specific action title", "desc": "Evidence-based recommendation"},
    {"priority": "30days", "title": "Specific action title", "desc": "Evidence-based recommendation"},
    {"priority": "ongoing", "title": "Specific action title", "desc": "Evidence-based recommendation"}
  ]
}

Rules: good>=65, warn 45-64, bad<45. healthCheckScore out of 100. scoreVerdict = Excellent/Good/Fair/Needs Attention`;

  // --- Call Claude ---
  let claudeResponse;
  try {
    const claudeReq = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      })
    });

    claudeResponse = await claudeReq.json();

  } catch (err) {
    return res.status(500).json({
      error: 'Failed to call Claude API',
      detail: err.message
    });
  }

  // --- Check for Claude API errors ---
  if (claudeResponse.error) {
    return res.status(500).json({
      error: 'Claude API returned an error',
      detail: claudeResponse.error.message,
      type: claudeResponse.error.type
    });
  }

  // --- Extract text from Claude response ---
  const textBlocks = (claudeResponse.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text);

  if (textBlocks.length === 0) {
    return res.status(500).json({
      error: 'Claude returned no text content',
      stopReason: claudeResponse.stop_reason,
      contentTypes: (claudeResponse.content || []).map(b => b.type)
    });
  }

  const rawText = textBlocks.join('').trim();

  // --- Parse JSON with multiple fallback strategies ---
  let report = null;

  // Strategy 1: Direct parse
  try {
    report = JSON.parse(rawText);
  } catch (e) { /* continue */ }

  // Strategy 2: Strip markdown fences
  if (!report) {
    try {
      const stripped = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      report = JSON.parse(stripped);
    } catch (e) { /* continue */ }
  }

  // Strategy 3: Find first { to last }
  if (!report) {
    try {
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        report = JSON.parse(rawText.slice(start, end + 1));
      }
    } catch (e) { /* continue */ }
  }

  // All strategies failed
  if (!report) {
    return res.status(500).json({
      error: 'Could not parse JSON from Claude response',
      firstChars: rawText.slice(0, 200),
      lastChars: rawText.slice(-200),
      totalLength: rawText.length
    });
  }

  // --- Validate the report has required fields ---
  if (!report.healthCheckScore || !report.pillars) {
    return res.status(500).json({
      error: 'Report JSON is missing required fields',
      hasScore: !!report.healthCheckScore,
      hasPillars: !!report.pillars,
      keys: Object.keys(report)
    });
  }

  // --- Success ---
  return res.status(200).json(report);
}
