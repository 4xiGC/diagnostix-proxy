// ================================================================
// DiagnostiX API Proxy — Vercel Serverless Function
// 
// DEPLOY IN 5 MINUTES:
// 1. Go to vercel.com and sign up free (use your GitHub or Google)
// 2. Click "Add New Project" → "Deploy from template"  
// 3. Choose "Next.js" starter — click Deploy
// 4. Once deployed, go to Project Settings → Environment Variables
// 5. Add variable: ANTHROPIC_API_KEY = your sk-ant-... key
// 6. Go to "Functions" tab or create /api folder with this file
// 7. Your URL will be: https://YOUR-PROJECT.vercel.app/api/diagnose
// ================================================================

export default async function handler(req, res) {
  // Allow CORS from your Wix site
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;

  if (!body || !body.name) {
    return res.status(400).json({ error: 'Restaurant name is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const s = body.sentiment || {};
  const prompt = `You are DiagnostiX by 4xi. Generate a restaurant HealthCheck report.

Restaurant: ${body.name}
Location: ${body.location || ''}
Website: ${body.website || 'not provided'}
Competitors: ${body.competitors || 'none'}

Owner survey (1-10): performance ${s.perf||5}, capacity ${s.cap||5}, staff retention ${s.ret||5}, ambiance ${s.amb||5}, repeat customers ${s.repeat||5}, bookings ${s.book||5}, menu ${s.menu||5}, online presence ${s.online||5}, pricing ${s.price||5}, optimism ${s.future||5}

Search the web for: "${body.name}" "${body.location}" restaurant reviews ratings Yelp Google TripAdvisor Glassdoor Instagram social media delivery platforms competitors.

Return ONLY valid JSON, no markdown:
{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"Modern American","priceDetected":"$$$","executiveSummary":"2-3 sentences using real web data","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real data"},{"name":"Yelp","score":65,"note":"real data"},{"name":"TripAdvisor","score":55,"note":"real data"},{"name":"OpenTable","score":60,"note":"real data"},{"name":"Social Media","score":50,"note":"real data"},{"name":"Delivery Platforms","score":35,"note":"real data"}]},"ownerSentimentSummary":"2 sentences about owner scores","sentimentGap":"1-2 sentences comparing owner vs market","reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Google","stars":3,"sentiment":"negative"},{"text":"real quote","source":"TripAdvisor","stars":3,"sentiment":"negative"}],"strengths":["strength 1","strength 2","strength 3"],"risks":["risk 1","risk 2","risk 3"],"themes":{"positive":["tag1","tag2","tag3"],"negative":["tag1","tag2"],"neutral":["tag1","tag2"]},"employeeSentiment":"1-2 sentences","competitiveInsight":"1-2 sentences","competitors":[{"name":"competitor","score":65,"note":"data"},{"name":"competitor","score":60,"note":"data"},{"name":"competitor","score":70,"note":"data"}],"actions":[{"priority":"urgent","title":"Action","desc":"description"},{"priority":"urgent","title":"Action","desc":"description"},{"priority":"30days","title":"Action","desc":"description"},{"priority":"30days","title":"Action","desc":"description"},{"priority":"ongoing","title":"Action","desc":"description"}]}

Rules: good>=65 warn 45-64 bad<45. Use REAL data from web searches.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await anthropicRes.json();

    if (data.error) {
      return res.status(500).json({ error: 'Anthropic: ' + data.error.message });
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const report = JSON.parse(text.replace(/```json|```/g, '').trim());
    return res.status(200).json(report);

  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
