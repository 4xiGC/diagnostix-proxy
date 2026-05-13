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
        system: 'You are a JSON API. Output ONLY valid JSON. No markdown. No backticks. Start with { end with }.',
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
    const sv = `perf=${s.perf||5} cap=${s.cap||5} ret=${s.ret||5} amb=${s.amb||5} repeat=${s.repeat||5} book=${s.book||5} menu=${s.menu||5} online=${s.online||5} price=${s.price||5} future=${s.future||5}`;
    console.log('[diagnose] claude part1...');
    const p1 = await claude(`Restaurant:${name}\nLocation:${location}\nSurvey:${sv}\nWebData:\n${web.slice(0,2500)}\n\nReturn JSON with real data from WebData above:\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"from data","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real"},{"name":"Yelp","score":65,"note":"real"},{"name":"TripAdvisor","score":55,"note":"real"},{"name":"OpenTable","score":60,"note":"real"},{"name":"Social Media","score":50,"note":"real"},{"name":"Delivery Platforms","score":35,"note":"real"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence"}\nRules:good>=65 warn=45-64 bad<45 scoreVerdict=Excellent/Good/Fair/Needs Attention`);
    console.log('[diagnose] p1 score:', p1.healthCheckScore);
    console.log('[diagnose] claude part2...');
    const p2 = await claude(`Restaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\nReturn JSON with real data:\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["real strength 1","real strength 2","real strength 3"],"risks":["real risk 1","real risk 2","real risk 3"],"themes":{"positive":["t1","t2","t3"],"negative":["t1","t2"],"neutral":["t1","t2"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real","score":68,"note":"data"},{"name":"real","score":62,"note":"data"},{"name":"real","score":71,"note":"data"}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}]}`);
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

// ── IN-MEMORY REPORT STORE ───────────────────────────────────
// Stores reports by email for 2 hours so payment redirect can retrieve them.
// Uses memory (not database) — simple, fast, no extra setup needed.
const reportStore = new Map();

// Clean up entries older than 2 hours every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of reportStore.entries()) {
    if (val.savedAt < cutoff) reportStore.delete(key);
  }
}, 30 * 60 * 1000);

// ── SAVE REPORT (called before Wix redirect) ──────────────────
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

  // Get email — try multiple field names Wix might use
  const email = (body.email || body.Email || body.contactEmail || '').toLowerCase().trim();
  const product = body.product || body.Product || 'full';

  if (!email) {
    console.log('[webhook] No email in body:', JSON.stringify(body));
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
    await markPurchasedAndEmail(email, body.firstName || '', body.restaurantName || '', {}, product);
    return;
  }

  const report     = saved.report || {};
  const survey     = saved.survey || {};
  const firstName  = body.firstName || survey.contactName || survey.firstName || '';
  const restaurant = survey.name || body.restaurantName || '';
  const location   = survey.location || '';

  console.log('[webhook] Payment confirmed for:', email, product, '| Restaurant:', restaurant);

  // Update HubSpot and send email
  await markPurchasedAndEmail(email, firstName, restaurant, report, product);
});

app.listen(PORT, () => console.log(`DiagnostiX v7 on port ${PORT}`));
