// DiagnostiX Vercel Proxy — with Serper.dev web search
// Uses Serper.dev for real web scraping (2,500 free searches/month)
// Then passes results to Claude for analysis and report generation

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

  // ─────────────────────────────────────────────────────────────
  // STEP 1: Run web searches via Serper.dev
  // ─────────────────────────────────────────────────────────────
  async function serperSearch(query) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, num: 8, gl: 'us', hl: 'en' })
      });
      const d = await r.json();
      // Extract useful snippets from organic results
      const results = (d.organic || []).map(item =>
        `[${item.title}] ${item.snippet || ''} (${item.link || ''})`
      ).join('\n');
      // Also grab knowledge graph if present
      const kg = d.knowledgeGraph ? 
        `Knowledge Graph: ${d.knowledgeGraph.title || ''} - ${d.knowledgeGraph.description || ''} Rating: ${d.knowledgeGraph.rating || ''} Reviews: ${d.knowledgeGraph.reviewCount || ''}` 
        : '';
      return [kg, results].filter(Boolean).join('\n');
    } catch (e) {
      return `Search failed: ${e.message}`;
    }
  }

  // Run 6 targeted searches in parallel for speed
  const [
    googleReviews,
    tripAdvisorYelp,
    employeeReviews,
    socialMedia,
    delivery,
    competitors
  ] = await Promise.all([
    serperSearch(`"${name}" ${location} restaurant reviews rating stars`),
    serperSearch(`"${name}" ${location} TripAdvisor Yelp OpenTable reviews`),
    serperSearch(`"${name}" ${location} Glassdoor Indeed employees work`),
    serperSearch(`"${name}" restaurant Instagram Facebook social media followers`),
    serperSearch(`"${name}" Uber Eats DoorDash Rappi delivery menu online order`),
    serperSearch(`best restaurants ${location} similar to "${name}" competitors`)
  ]);

  const webData = `
=== GOOGLE & GENERAL REVIEWS ===
${googleReviews}

=== TRIPADVISOR / YELP / OPENTABLE ===
${tripAdvisorYelp}

=== EMPLOYEE REVIEWS (GLASSDOOR/INDEED) ===
${employeeReviews}

=== SOCIAL MEDIA ===
${socialMedia}

=== DELIVERY PLATFORMS ===
${delivery}

=== COMPETITORS ===
${competitors}
`.trim();

  // ─────────────────────────────────────────────────────────────
  // STEP 2: Pass web data + survey to Claude for report generation
  // ─────────────────────────────────────────────────────────────
  const prompt = `You are DiagnostiX, 4xi's restaurant performance intelligence platform.

Using the REAL WEB DATA below, generate a comprehensive HealthCheck report for this restaurant.

RESTAURANT: ${name}
LOCATION: ${location}
WEBSITE: ${body.website || 'not provided'}
COMPETITORS NAMED BY OWNER: ${body.competitors || 'none'}

OWNER SENTIMENT SURVEY (1-10 scale):
- Overall business performance: ${s.perf || 5}/10
- Customer volume vs capacity: ${s.cap || 5}/10
- Staff retention: ${s.ret || 5}/10
- Ambiance & venue condition: ${s.amb || 5}/10
- Repeat / return customers: ${s.repeat || 5}/10
- Advance booking depth: ${s.book || 5}/10
- Menu strength & appeal: ${s.menu || 5}/10
- Online presence effectiveness: ${s.online || 5}/10
- Pricing vs value delivered: ${s.price || 5}/10
- 12-month business optimism: ${s.future || 5}/10

LIVE WEB DATA (from real searches conducted right now):
${webData}

INSTRUCTIONS:
- Use the web data above to extract REAL ratings, review counts, quotes and insights
- Identify the cuisine type and price point from the data
- Find real review verbatims (actual quotes from customers)
- Score each pillar based on evidence from the web data
- Compare owner sentiment scores against what the market data shows
- Identify real named competitors from the search results
- Generate specific, evidence-based action items

Return ONLY a valid JSON object with no markdown, no backticks, no explanation:
{
  "healthCheckScore": 72,
  "scoreVerdict": "Good",
  "cuisineDetected": "from web data",
  "priceDetected": "$$",
  "executiveSummary": "2-3 sentences referencing REAL data found e.g. actual star ratings and review counts",
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
      {"name": "Google Business", "score": 80, "note": "real data e.g. 4.3 stars, 284 reviews"},
      {"name": "Yelp", "score": 65, "note": "real data found or note if not listed"},
      {"name": "TripAdvisor", "score": 55, "note": "real data found or note if not listed"},
      {"name": "OpenTable / Resy", "score": 60, "note": "real data found or note if not listed"},
      {"name": "Social Media", "score": 50, "note": "real data e.g. Instagram followers count"},
      {"name": "Delivery Platforms", "score": 35, "note": "real data or note if not present"}
    ]
  },
  "ownerSentimentSummary": "2 sentences interpreting owner survey vs what web data shows",
  "sentimentGap": "1-2 sentences on key gaps between owner perception and market reality",
  "reviewVerbatims": [
    {"text": "real quote extracted from web data above", "source": "Google", "stars": 5, "sentiment": "positive"},
    {"text": "real quote extracted from web data above", "source": "TripAdvisor", "stars": 4, "sentiment": "positive"},
    {"text": "real quote extracted from web data above", "source": "Yelp", "stars": 3, "sentiment": "negative"},
    {"text": "real quote from web data", "source": "Google", "stars": 3, "sentiment": "negative"}
  ],
  "strengths": [
    "specific strength with evidence from web data",
    "specific strength with evidence",
    "specific strength with evidence"
  ],
  "risks": [
    "specific risk with evidence from web data",
    "specific risk with evidence",
    "specific risk with evidence"
  ],
  "themes": {
    "positive": ["real theme from reviews", "real theme", "real theme"],
    "negative": ["real theme from reviews", "real theme"],
    "neutral": ["real theme", "real theme"]
  },
  "employeeSentiment": "1-2 sentences from Glassdoor/Indeed data, or note if no data found",
  "competitiveInsight": "1-2 sentences about competitive landscape from search results",
  "competitors": [
    {"name": "real competitor from search", "score": 68, "note": "brief real data"},
    {"name": "real competitor from search", "score": 62, "note": "brief real data"},
    {"name": "real competitor from search", "score": 71, "note": "brief real data"}
  ],
  "actions": [
    {"priority": "urgent", "title": "Specific action title", "desc": "Evidence-based action from real data found above"},
    {"priority": "urgent", "title": "Specific action title", "desc": "Evidence-based action"},
    {"priority": "30days", "title": "Specific action title", "desc": "Evidence-based action"},
    {"priority": "30days", "title": "Specific action title", "desc": "Evidence-based action"},
    {"priority": "ongoing", "title": "Specific action title", "desc": "Evidence-based action"}
  ]
}

Scoring: good >= 65, warn 45-64, bad < 45. healthCheckScore out of 100.
scoreVerdict must be exactly: Excellent / Good / Fair / Needs Attention`;

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
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();

    if (claudeData.error) {
      return res.status(500).json({ error: 'Claude error: ' + claudeData.error.message });
    }

    const text = (claudeData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON — handle any accidental markdown fences
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    let report;
    try {
      report = JSON.parse(cleaned);
    } catch (e) {
      // Try to extract JSON if there's surrounding text
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        report = JSON.parse(match[0]);
      } else {
        return res.status(500).json({ 
          error: 'Could not parse report JSON',
          preview: text.slice(0, 400)
        });
      }
    }

    return res.status(200).json(report);

  } catch (err) {
    return res.status(500).json({ error: 'Request failed: ' + String(err) });
  }
}
