import express from 'express';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
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
const reportStore = new Map();
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.json({ status: 'running', version: '7.0' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '7.0' });
});

app.get('/test', async (req, res) => {
  const ak = process.env.ANTHROPIC_API_KEY;
  const sk = process.env.SERPER_API_KEY;
  const result = { ak_present: !!ak, ak_prefix: ak ? ak.slice(0,15)+'...' : 'MISSING', sk_present: !!sk };
  if (ak) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] })
      });
      const d = await r.json();
      result.ak_status = r.status;
      result.ak_ok = !d.error;
      if (d.error) result.ak_error = d.error.message;
    } catch(e) { result.ak_error = e.message; }
  }
  res.json(result);
});

app.post('/diagnose', async (req, res) => {
  const body = req.body;
  if (!body || !body.name) return res.status(400).json({ error: 'Restaurant name is required' });
  const ak = process.env.ANTHROPIC_API_KEY;
  const sk = process.env.SERPER_API_KEY;
  if (!ak) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
  if (!sk) return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  const name = String(body.name);
  const location = String(body.location || '');
  const s = body.sentiment || {};
  console.log(`[diagnose] ${name} | ${location}`);
  async function search(q) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST', headers: { 'X-API-KEY': sk, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 5 })
      });
      const d = await r.json();
      let o = '';
      if (d.knowledgeGraph) { const kg=d.knowledgeGraph; o+=`[${kg.title||''}] Rating:${kg.rating||'N/A'} (${kg.reviewCount||0} reviews) ${kg.description||''}\n`; }
      (d.organic||[]).slice(0,4).forEach(i=>{ o+=`${i.title}: ${i.snippet||''}\n`; });
      return o||'no data';
    } catch(e) { return 'err:'+e.message; }
  }
  async function claude(prompt) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 2000,
        system: 'You are a JSON API. Output ONLY valid JSON. No markdown. No backticks. Start with { end with }. CRITICAL: All text values in the JSON must be written in English, regardless of the language of the source data or the restaurant\'s location.',
        messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const t = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    try { return JSON.parse(t); } catch(e) {}
    const i=t.indexOf('{'), j=t.lastIndexOf('}');
    if (i>=0&&j>i) return JSON.parse(t.slice(i,j+1));
    throw new Error('JSON fail:'+t.slice(0,100));
  }
  try {
    console.log('[diagnose] searching...');
    const [g,rv,st,so,dl,co] = await Promise.all([
      search(`"${name}" ${location} restaurant`),
      search(`"${name}" ${location} reviews TripAdvisor Yelp OpenTable`),
      search(`"${name}" Glassdoor Indeed employees`),
      search(`"${name}" Instagram Facebook social media`),
      search(`"${name}" Uber Eats DoorDash delivery`),
      search(`best restaurants ${location} competitors ${name}`)
    ]);
    const web = `GOOGLE:${g}\nREVIEWS:${rv}\nSTAFF:${st}\nSOCIAL:${so}\nDELIVERY:${dl}\nCOMPETITORS:${co}`;
    console.log('[diagnose] web len:', web.length, '| google:', g.slice(0,80));
    const sv = `OWNER SELF-ASSESSMENT (1=low 10=high):
- Overall business performance satisfaction: ${s.perf||5}/10
- Customer volume vs capacity: ${s.cap||5}/10
- Staff retention & team stability: ${s.ret||5}/10
- Venue ambiance & physical condition: ${s.amb||5}/10
- Level of repeat/return customers: ${s.repeat||5}/10
- How far in advance fully booked: ${s.book||5}/10
- Menu strength & appeal: ${s.menu||5}/10
- Online presence effectiveness: ${s.online||5}/10
- Pricing vs value delivered: ${s.price||5}/10
- 12-month business optimism: ${s.future||5}/10
Owner average score: ${Math.round(Object.values(s).reduce((a,b)=>a+(b||5),0)/10*10)/10}/10`;
    console.log('[diagnose] claude part1...');
    const p1 = await claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language.\n\nRestaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${sv}\n\nReturn JSON. Use WebData for scores. Use Owner Self-Assessment to write ownerSentimentSummary (2 sentences interpreting what owner thinks vs what data shows) and sentimentGap (1 sentence on biggest gap between owner perception and reality).\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"from data","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real"},{"name":"Yelp","score":65,"note":"real"},{"name":"TripAdvisor","score":55,"note":"real"},{"name":"OpenTable","score":60,"note":"real"},{"name":"Social Media","score":50,"note":"real"},{"name":"Delivery Platforms","score":35,"note":"real"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence"}\nRules:good>=65 warn=45-64 bad<45 scoreVerdict=Excellent/Good/Fair/Needs Attention`);
    console.log('[diagnose] p1 score:', p1.healthCheckScore);
    console.log('[diagnose] claude part2...');
    const p2 = await claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language. Translate any non-English review quotes into English.\n\nRestaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\nReturn JSON with real data:\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["real strength 1","real strength 2","real strength 3"],"risks":["real risk 1","real risk 2","real risk 3"],"themes":{"positive":["t1","t2","t3"],"negative":["t1","t2"],"neutral":["t1","t2"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real","score":68,"note":"data"},{"name":"real","score":62,"note":"data"},{"name":"real","score":71,"note":"data"}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}]}`);
    console.log('[diagnose] p2 actions:', p2.actions?.length);
    const report = Object.assign({}, p1, p2);
    if (!report.healthCheckScore || !report.pillars) throw new Error('missing fields: '+Object.keys(report).join(','));
    console.log('[diagnose] SUCCESS score:', report.healthCheckScore);
    return res.status(200).json(report);
  } catch(e) {
    console.error('[diagnose] FAILED:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── TRANSLATE REPORT ─────────────────────────────────────────
// Takes an already-generated report's text fields and translates them.
// No re-scraping needed — just text translation via Claude.
app.post('/translate', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lang, langName, data } = req.body;
  if (!lang || !data) return res.status(400).json({ error: 'lang and data required' });
  if (lang === 'en') return res.json(data); // nothing to do

  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  console.log(`[translate] Translating report to ${langName} (${lang})`);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: `You are a professional translator. Translate all string values in the JSON object into ${langName}. 
Output ONLY valid JSON with the exact same structure and keys. No markdown. No backticks. Start with { end with }.
Rules:
- Translate every string value. Do not translate keys.
- Keep numbers, null, and boolean values unchanged.
- For arrays of strings, translate each string.
- Preserve proper nouns (restaurant names, platform names like Google, TripAdvisor, etc.).
- Keep the same professional tone as the original.`,
        messages: [{ role: 'user', content: `Translate this JSON into ${langName}:\n${JSON.stringify(data)}` }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let parsed;
    try { parsed = JSON.parse(t); }
    catch(e) {
      const i = t.indexOf('{'), j = t.lastIndexOf('}');
      if (i >= 0 && j > i) parsed = JSON.parse(t.slice(i, j + 1));
      else throw new Error('JSON parse failed');
    }
    console.log(`[translate] Success → ${langName}`);
    return res.status(200).json(parsed);
  } catch(e) {
    console.error('[translate] FAILED:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── IN-MEMORY REPORT STORE ───────────────────────────────────
app.post('/save-report', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { email, report, survey, product } = req.body;
  if (!email || !report) {
    return res.status(400).json({ error: 'email and report required' });
  }
  const key = email.toLowerCase().trim();
  reportStore.set(key, { report, survey, product: product || 'full', savedAt: Date.now() });
  console.log('[save-report] Saved for:', key);
  res.status(200).json({ ok: true });
});

// ── GET REPORT (called on payment return) ─────────────────────
app.get('/get-report', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });

  const saved = reportStore.get(email);
  if (!saved) {
    console.log('[get-report] Not found for:', email);
    return res.status(404).json({ error: 'Report not found or expired' });
  }

  // Check not older than 2 hours
  if (Date.now() - saved.savedAt > 2 * 60 * 60 * 1000) {
    reportStore.delete(email);
    return res.status(404).json({ error: 'Report expired' });
  }

  console.log('[get-report] Retrieved for:', email);
  res.status(200).json({ report: saved.report, survey: saved.survey, product: saved.product });
});

// ── HUBSPOT INTEGRATION ──────────────────────────────────────

// Create or update a HubSpot contact with DiagnostiX data
async function saveToHubSpot(email, firstName, restaurantName, location, report) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    const properties = {
      email,
      firstname:               firstName || '',
      restaurant_name:         restaurantName || '',
      restaurant_location:     location || '',
      diagnostix_score:        report.healthCheckScore || 0,
      diagnostix_verdict:      report.scoreVerdict || '',
      diagnostix_cuisine:      report.cuisineDetected || '',
      diagnostix_online_score: report.onlinePresence && report.onlinePresence.overall ? report.onlinePresence.overall : 0,
      diagnostix_date:         new Date().toISOString().split('T')[0],
      report_purchased:        false,
      lead_source:             'DiagnostiX'
    };
    // Try create first, fall back to update if contact exists
    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ properties })
    });
    const createData = await createRes.json();
    if (createData.status === 'error' && createData.message && createData.message.includes('already exists')) {
      // Contact exists — update instead
      const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
      });
      const searchData = await searchRes.json();
      if (searchData.results && searchData.results[0]) {
        await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + searchData.results[0].id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ properties })
        });
      }
    }
    console.log('[hubspot] Contact saved:', email);
  } catch(e) {
    console.log('[hubspot] Failed:', e.message);
  }
}

// Mark contact as purchased and send report email via HubSpot
async function markPurchasedAndEmail(email, firstName, restaurantName, report, product) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    // 1 — Find the contact
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results && searchData.results[0] ? searchData.results[0].id : null;

    if (contactId) {
      // 2 — Mark as purchased
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties: {
          report_purchased:   true,
          subscription_active: product === 'annual'
        }})
      });
      console.log('[hubspot] Marked purchased:', email, product);
    }

    // 3 — Log a note on the HubSpot contact record about the purchase
    if (contactId) {
      await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          properties: {
            hs_note_body: 'DiagnostiX ' + product + ' report purchased. Score: ' + (report.healthCheckScore || 'N/A') + '. Restaurant: ' + restaurantName,
            hs_timestamp: new Date().toISOString()
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
          }]
        })
      });
    }
    console.log('[hubspot] Note added for:', email);
  } catch(e) {
    console.log('[hubspot] Email failed:', e.message);
  }
}

// ── PAYMENT WEBHOOK ────────────────────────────────────────────
// Called by Wix Automation after successful payment
app.post('/payment-webhook', async (req, res) => {
  res.status(200).json({ ok: true }); // Always respond quickly

  // Log everything received so we can debug
  console.log('[webhook] Received body:', JSON.stringify(req.body));
  console.log('[webhook] Current report store keys:', Array.from(reportStore.keys()));

  const body = req.body;
  if (!body) {
    console.log('[webhook] Empty body received');
    return;
  }

  // Wix wraps payload in a "data" object — handle both formats
  const payload = body.data || body;

  // Get email — try multiple field names Wix might use
  const email = (payload.email || payload.Email || payload.contactEmail || body.email || '').toLowerCase().trim();
  const product = payload.product || payload.Product || body.product || 'full';
  const firstName = payload.firstName || payload.first_name || body.firstName || '';

  if (!email) {
    console.log('[webhook] No email found in body:', JSON.stringify(body));
    return;
  }

  console.log('[webhook] Looking up email:', email);

  // Try to find saved report — also try partial email match
  let saved = reportStore.get(email);
  if (!saved) {
    // Try to find by searching all keys for similar email
    for (const [key, val] of reportStore.entries()) {
      if (key.includes(email.split('@')[0]) || email.includes(key.split('@')[0])) {
        saved = val;
        console.log('[webhook] Found report via partial match:', key, '->', email);
        break;
      }
    }
  }

  if (!saved) {
    console.log('[webhook] No saved report for:', email, '| Store has:', reportStore.size, 'entries');
    // Still proceed with HubSpot update even without saved report
    await markPurchasedAndEmail(email, firstName || '', payload.restaurantName || '', {}, product);
    return;
  }

  const report     = saved.report || {};
  const survey     = saved.survey || {};
  const resolvedFirstName = firstName || survey.contactName || survey.firstName || '';
  const restaurant = survey.name || body.restaurantName || '';
  const location   = survey.location || '';

  console.log('[webhook] Payment confirmed for:', email, product, '| Restaurant:', restaurant);

  // Update HubSpot and send email
  await markPurchasedAndEmail(email, resolvedFirstName, restaurant, report, product);

  // For annual subscribers — register them for automated reports
  if (product === 'annual' && report && Object.keys(report).length > 0) {
    await fetch('http://localhost:' + PORT + '/subscribe-annual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        firstName:      resolvedFirstName,
        restaurantName: restaurant,
        location:       survey.location || '',
        website:        survey.website  || '',
        report,
        survey
      })
    }).catch(e => console.log('[webhook] subscribe-annual call failed:', e.message));
    console.log('[webhook] Annual subscription registered for:', email);
  }
});

// ── ANNUAL SUBSCRIPTION STORE ────────────────────────────────
// In-memory store of annual subscribers (persists until server restart)
// In production, these should be in Supabase — see /subscribe-annual endpoint
const annualSubscribers = new Map();

// ── SUBSCRIBE ANNUAL ─────────────────────────────────────────
// Called by payment webhook when product === 'annual'
// Stores subscriber with baseline report and schedules 3 reports/year
app.post('/subscribe-annual', async (req, res) => {
  res.status(200).json({ ok: true });
  const { email, firstName, restaurantName, location, website, report, survey } = req.body;
  if (!email) return;

  const now = Date.now();
  const subscriber = {
    email,
    firstName:      firstName || '',
    restaurantName: restaurantName || '',
    location:       location || '',
    website:        website || '',
    subscribedAt:   now,
    reports: [
      { generatedAt: now, report, survey, reportNumber: 1 }
    ],
    nextReportAt: now + (4 * 30 * 24 * 60 * 60 * 1000) // 4 months
  };

  annualSubscribers.set(email.toLowerCase(), subscriber);
  console.log('[annual] Subscriber added:', email, '| Next report:', new Date(subscriber.nextReportAt).toISOString());

  // Save to Supabase subscribers table
  await saveSubscriberToSupabase(subscriber);
});

// ── SAVE SUBSCRIBER TO SUPABASE ──────────────────────────────
async function saveSubscriberToSupabase(sub) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/subscribers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        email:           sub.email,
        first_name:      sub.firstName,
        restaurant_name: sub.restaurantName,
        location:        sub.location,
        website:         sub.website,
        subscribed_at:   new Date(sub.subscribedAt).toISOString(),
        next_report_at:  new Date(sub.nextReportAt).toISOString(),
        reports_sent:    1,
        active:          true,
        baseline_score:  sub.reports[0]?.report?.healthCheckScore || 0
      })
    });
    console.log('[supabase] Subscriber saved:', sub.email);
  } catch(e) {
    console.log('[supabase] Subscriber save failed:', e.message);
  }
}

// ── GENERATE PROGRESS REPORT ─────────────────────────────────
// Compares current data against baseline report and previous reports
async function generateProgressReport(sub) {
  const { email, firstName, restaurantName, location, website } = sub;
  const baseline = sub.reports[0];
  const previous = sub.reports[sub.reports.length - 1];
  const reportNumber = sub.reports.length + 1;

  console.log('[annual] Generating report', reportNumber, 'for:', email);

  try {
    // Re-run web scraping
    const [g, rv, st, so, dl, co] = await Promise.all([
      search(`"${restaurantName}" ${location} restaurant`),
      search(`"${restaurantName}" ${location} reviews TripAdvisor Yelp OpenTable`),
      search(`"${restaurantName}" Glassdoor Indeed employees`),
      search(`"${restaurantName}" Instagram Facebook social media`),
      search(`"${restaurantName}" Uber Eats DoorDash delivery`),
      search(`best restaurants ${location} competitors ${restaurantName}`)
    ]);
    const web = `GOOGLE:${g}\nREVIEWS:${rv}\nSTAFF:${st}\nSOCIAL:${so}\nDELIVERY:${dl}\nCOMPETITORS:${co}`;

    // Build baseline comparison context
    const baselineCtx = `BASELINE REPORT (${new Date(baseline.generatedAt).toLocaleDateString()}):
- HealthCheck Score: ${baseline.report.healthCheckScore}/100 (${baseline.report.scoreVerdict})
- Customer Sentiment: ${baseline.report.pillars?.cs?.score}/100
- Pricing & Accessibility: ${baseline.report.pillars?.pa?.score}/100
- Employee Sentiment: ${baseline.report.pillars?.es?.score}/100
- Social Media: ${baseline.report.pillars?.sm?.score}/100
- Competitive Position: ${baseline.report.pillars?.cp?.score}/100
- Brand Experience: ${baseline.report.pillars?.bg?.score}/100
- Online Presence: ${baseline.report.onlinePresence?.overall}/100
PREVIOUS ACTIONS: ${(baseline.report.actions||[]).map(a=>a.title).join('; ')}`;

    const prevCtx = sub.reports.length > 1 ? `PREVIOUS REPORT (${new Date(previous.generatedAt).toLocaleDateString()}):
- HealthCheck Score: ${previous.report.healthCheckScore}/100
- Trend: ${previous.report.healthCheckScore > baseline.report.healthCheckScore ? 'Improving' : 'Declining'}` : '';

    // Generate current report
    const p1 = await claude(`Restaurant:${restaurantName}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${baselineCtx}\n${prevCtx}\n\nThis is report ${reportNumber} of 3 for an annual subscriber. Return JSON:\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings and progress vs baseline","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":""},{"name":"Yelp","score":65,"note":""},{"name":"TripAdvisor","score":55,"note":""},{"name":"OpenTable","score":60,"note":""},{"name":"Social Media","score":50,"note":""},{"name":"Delivery Platforms","score":35,"note":""}]},"ownerSentimentSummary":"","sentimentGap":""}\nRules:good>=65 warn=45-64 bad<45`);

    const p2 = await claude(`Restaurant:${restaurantName}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${baselineCtx}\n\nReturn JSON with progress tracking:\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":3,"sentiment":"negative"}],"strengths":["strength 1","strength 2","strength 3"],"risks":["risk 1","risk 2","risk 3"],"themes":{"positive":["t1","t2"],"negative":["t1"],"neutral":["t1"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real","score":68,"note":""},{"name":"real","score":62,"note":""},{"name":"real","score":71,"note":""}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}],"progress":{"overallChange":${(p1.healthCheckScore||70) - baseline.report.healthCheckScore},"pillarsProgress":{"cs":${(p1.pillars?.cs?.score||70) - (baseline.report.pillars?.cs?.score||70)},"pa":${(p1.pillars?.pa?.score||65) - (baseline.report.pillars?.pa?.score||65)},"es":${(p1.pillars?.es?.score||50) - (baseline.report.pillars?.es?.score||50)},"sm":${(p1.pillars?.sm?.score||55) - (baseline.report.pillars?.sm?.score||55)},"cp":${(p1.pillars?.cp?.score||70) - (baseline.report.pillars?.cp?.score||70)},"bg":${(p1.pillars?.bg?.score||65) - (baseline.report.pillars?.bg?.score||65)}},"completedActions":[],"ongoingPriorities":[],"progressNarrative":"2 sentences on what has improved and what still needs work"}}`);

    const report = Object.assign({}, p1, p2, {
      reportNumber,
      baselineScore: baseline.report.healthCheckScore,
      generatedAt: new Date().toISOString(),
      isProgressReport: true
    });

    // Store this report in subscriber history
    sub.reports.push({ generatedAt: Date.now(), report, reportNumber });

    // Update next report date (or mark complete if 3 reports done)
    if (reportNumber < 3) {
      sub.nextReportAt = Date.now() + (4 * 30 * 24 * 60 * 60 * 1000);
    } else {
      sub.nextReportAt = null; // All 3 reports delivered
      sub.completedAt = Date.now();
    }

    console.log('[annual] Report', reportNumber, 'generated for:', email, '| Score:', report.healthCheckScore);

    // Send email via Wix automation webhook
    await sendProgressReportEmail(sub, report);

    // Update Supabase
    await updateSubscriberInSupabase(sub, reportNumber);

    return report;
  } catch(e) {
    console.log('[annual] Report generation failed for:', email, e.message);
  }
}

// ── SEND PROGRESS REPORT EMAIL ───────────────────────────────
async function sendProgressReportEmail(sub, report) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return;

  const score = report.healthCheckScore || 0;
  const baseline = sub.reports[0]?.report?.healthCheckScore || 0;
  const change = score - baseline;
  const changeStr = change > 0 ? '+' + change : String(change);
  const changeColor = change > 0 ? '#00A651' : change < 0 ? '#ED1C24' : '#888';
  const reportUrl = 'https://diagnostix-proxy-production.up.railway.app';

  // Build progress rows for pillars
  const pillarsHtml = Object.entries(report.pillars || {}).map(([key, p]) => {
    const prev = sub.reports[0]?.report?.pillars?.[key]?.score || p.score;
    const diff = p.score - prev;
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const col = diff > 0 ? '#00A651' : diff < 0 ? '#ED1C24' : '#888';
    return `<tr><td style="padding:6px 10px;font-size:13px;color:#333">${p.label}</td><td style="padding:6px 10px;text-align:center;font-size:13px;color:#333">${prev}</td><td style="padding:6px 10px;text-align:center;font-size:13px;color:#333">${p.score}</td><td style="padding:6px 10px;text-align:center;font-size:13px;font-weight:700;color:${col}">${arrow} ${Math.abs(diff)}</td></tr>`;
  }).join('');

  try {
    // Add note to HubSpot contact
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: sub.email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results?.[0]?.id;

    if (contactId) {
      await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          properties: {
            hs_note_body: `DiagnostiX Annual Report ${report.reportNumber}/3 delivered. Score: ${score}/100 (${changeStr} vs baseline). Restaurant: ${sub.restaurantName}`,
            hs_timestamp: new Date().toISOString()
          },
          associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
        })
      });
    }
    console.log('[annual] HubSpot note added for:', sub.email);
  } catch(e) {
    console.log('[annual] HubSpot note failed:', e.message);
  }
}

// ── UPDATE SUBSCRIBER IN SUPABASE ────────────────────────────
async function updateSubscriberInSupabase(sub, reportNumber) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/subscribers?email=eq.${encodeURIComponent(sub.email)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        reports_sent:   reportNumber,
        next_report_at: sub.nextReportAt ? new Date(sub.nextReportAt).toISOString() : null,
        active:         sub.nextReportAt ? true : false,
        latest_score:   sub.reports[sub.reports.length - 1]?.report?.healthCheckScore || 0
      })
    });
    console.log('[supabase] Subscriber updated:', sub.email, 'report', reportNumber);
  } catch(e) {
    console.log('[supabase] Subscriber update failed:', e.message);
  }
}

// ── LOAD SUBSCRIBERS FROM SUPABASE ON STARTUP ─────────────────
async function loadSubscribersFromSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/subscribers?active=eq.true&select=*`, {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    const rows = await res.json();
    if (Array.isArray(rows)) {
      rows.forEach(row => {
        annualSubscribers.set(row.email, {
          email:          row.email,
          firstName:      row.first_name || '',
          restaurantName: row.restaurant_name || '',
          location:       row.location || '',
          website:        row.website || '',
          subscribedAt:   new Date(row.subscribed_at).getTime(),
          nextReportAt:   row.next_report_at ? new Date(row.next_report_at).getTime() : null,
          reports:        [{ generatedAt: new Date(row.subscribed_at).getTime(), report: { healthCheckScore: row.baseline_score || 0, pillars: {} }, reportNumber: 1 }]
        });
      });
      console.log('[annual] Loaded', rows.length, 'active subscribers from Supabase');
    }
  } catch(e) {
    console.log('[annual] Failed to load subscribers from Supabase:', e.message);
  }
}
loadSubscribersFromSupabase();

// ── DAILY SCHEDULER — check for due reports every 6 hours ───
setInterval(async () => {
  const now = Date.now();
  console.log('[scheduler] Checking', annualSubscribers.size, 'subscribers for due reports...');
  for (const [email, sub] of annualSubscribers.entries()) {
    if (sub.nextReportAt && now >= sub.nextReportAt) {
      console.log('[scheduler] Report due for:', email);
      await generateProgressReport(sub);
      // Stagger to avoid API rate limits
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}, 6 * 60 * 60 * 1000); // every 6 hours

// ── MANUAL TRIGGER (for testing) ─────────────────────────────
app.post('/trigger-annual-report', async (req, res) => {
  const { email, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const sub = annualSubscribers.get((email||'').toLowerCase());
  if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
  res.status(200).json({ ok: true, message: 'Report generation started' });
  await generateProgressReport(sub);
});

app.listen(PORT, () => console.log(`DiagnostiX v7 on port ${PORT}`));
