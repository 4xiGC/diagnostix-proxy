import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
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
const annualSubscribers = new Map();

// ── SHARED HELPERS (Serper + Claude) ─────────────────────────
// Lifted out so both /diagnose and generateProgressReport can use them.
async function search(q) {
  const sk = process.env.SERPER_API_KEY;
  if (!sk) return 'no api key';
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': sk, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 5 })
    });
    const d = await r.json();
    let o = '';
    if (d.knowledgeGraph) {
      const kg = d.knowledgeGraph;
      o += `[${kg.title||''}] Rating:${kg.rating||'N/A'} (${kg.reviewCount||0} reviews) ${kg.description||''}\n`;
    }
    (d.organic||[]).slice(0,4).forEach(i => { o += `${i.title}: ${i.snippet||''}\n`; });
    return o || 'no data';
  } catch(e) { return 'err:'+e.message; }
}

async function claude(prompt) {
  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) throw new Error('ANTHROPIC_API_KEY missing');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: 'You are a JSON API. Output ONLY valid JSON. No markdown. No backticks. Start with { end with }. CRITICAL: All text values in the JSON must be written in English, regardless of the language of the source data or the restaurant\'s location.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const t = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  try { return JSON.parse(t); } catch(e) {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i>=0 && j>i) return JSON.parse(t.slice(i, j+1));
  throw new Error('JSON fail:'+t.slice(0,100));
}

// ── EMAIL VIA RESEND ─────────────────────────────────────────
async function sendEmailViaResend({ to, subject, html, fromName }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'reports@4xi360.com';
  if (!key) {
    console.log('[email] RESEND_API_KEY missing — skipping send to', to);
    return { ok: false, reason: 'missing key' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: (fromName || 'DiagnostiX') + ' <' + from + '>',
        to: [to],
        subject,
        html
      })
    });
    const d = await r.json();
    if (d.id) {
      console.log('[email] sent to', to, '| id:', d.id);
      return { ok: true, id: d.id };
    }
    console.log('[email] Resend rejected:', JSON.stringify(d));
    return { ok: false, reason: d.message || 'unknown' };
  } catch(e) {
    console.log('[email] send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── ROOT + HEALTH + TEST ─────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.json({ status: 'running', version: '8.0' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '8.0' });
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

// ── /diagnose ────────────────────────────────────────────────
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

// ── /translate ───────────────────────────────────────────────
app.post('/translate', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lang, langName, data } = req.body;
  if (!lang || !data) return res.status(400).json({ error: 'lang and data required' });
  if (lang === 'en') return res.json(data);

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

// ── /save-report ─────────────────────────────────────────────
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

// ── /get-report ──────────────────────────────────────────────
app.get('/get-report', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });

  const saved = reportStore.get(email);
  if (!saved) {
    console.log('[get-report] Not found for:', email);
    return res.status(404).json({ error: 'Report not found or expired' });
  }

  if (Date.now() - saved.savedAt > 2 * 60 * 60 * 1000) {
    reportStore.delete(email);
    return res.status(404).json({ error: 'Report expired' });
  }

  console.log('[get-report] Retrieved for:', email);
  res.status(200).json({ report: saved.report, survey: saved.survey, product: saved.product });
});

// ── HUBSPOT (legacy contact sync, kept for compatibility) ────
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
    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ properties })
    });
    const createData = await createRes.json();
    if (createData.status === 'error' && createData.message && createData.message.includes('already exists')) {
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

async function markPurchasedAndEmail(email, firstName, restaurantName, report, product) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results && searchData.results[0] ? searchData.results[0].id : null;

    if (contactId) {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties: {
          report_purchased:   true,
          subscription_active: product === 'annual'
        }})
      });
      console.log('[hubspot] Marked purchased:', email, product);

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
    console.log('[hubspot] markPurchasedAndEmail failed:', e.message);
  }
}

// ── HUBSPOT — 20-PROPERTY CONTEXT PUSH ───────────────────────
async function pushReportContextToHubSpot({ subscriber, report, reportNumber, reportUrl, baseline }) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !subscriber?.email) return;

  const isAnnual = subscriber.plan_type === 'annual';
  const score = report?.healthCheckScore || 0;
  const baselineScore = baseline?.healthCheckScore || 0;

  const trajectory = reportNumber === 1 ? '' : (
    score - baselineScore >= 3 ? 'improving' :
    score - baselineScore <= -3 ? 'declining' : 'flat'
  );

  const weakestPillar = (() => {
    const pillars = report?.pillars || {};
    let lowest = null;
    for (const k of Object.keys(pillars)) {
      const p = pillars[k];
      if (typeof p.score === 'number' && (!lowest || p.score < lowest.score)) {
        lowest = { score: p.score, label: p.label || k };
      }
    }
    return lowest?.label || '';
  })();

  const lifecycle = (() => {
    if (!isAnnual) return 'one_off';
    const daysSinceSubscribe = Math.floor((Date.now() - new Date(subscriber.subscribed_at).getTime()) / (24*60*60*1000));
    if (daysSinceSubscribe < 30) return 'new_buyer';
    if (daysSinceSubscribe >= 365) return 'lapsed';
    if (daysSinceSubscribe >= 305) return 'near_renewal';
    return 'mid_cycle';
  })();

  const properties = {
    email: subscriber.email,
    diagnostix_plan_type:           subscriber.plan_type || 'annual',
    diagnostix_subscription_status: subscriber.active === false && isAnnual ? 'expired' : isAnnual ? 'active' : 'completed',
    diagnostix_amount_paid_usd:     subscriber.amount_paid || 0,
    diagnostix_report_url:          reportUrl,
    diagnostix_report_token:        subscriber.report_token,
    diagnostix_reports_delivered:   reportNumber,
    diagnostix_latest_score:        score,
    diagnostix_score_trajectory:    trajectory,
    diagnostix_weakest_pillar:      weakestPillar,
    diagnostix_lifecycle_stage:     lifecycle,
    diagnostix_subscribed_at:       new Date(subscriber.subscribed_at).toISOString().split('T')[0]
  };

  if (reportNumber === 1) {
    properties.diagnostix_baseline_score = score;
    if (isAnnual) {
      properties.diagnostix_next_report_due = new Date(subscriber.next_report_at).toISOString().split('T')[0];
      properties.diagnostix_subscription_expires = new Date(
        new Date(subscriber.subscribed_at).getTime() + (365*24*60*60*1000)
      ).toISOString().split('T')[0];
    }
  } else if (reportNumber === 2) {
    properties.diagnostix_report_2_score = score;
    properties.diagnostix_next_report_due = new Date(subscriber.next_report_at).toISOString().split('T')[0];
  } else if (reportNumber === 3) {
    properties.diagnostix_report_3_score = score;
    properties.diagnostix_next_report_due = null;
  }

  if (report?.pillars?.cs?.score != null) properties.diagnostix_customer_sentiment_score = report.pillars.cs.score;
  if (report?.pillars?.pa?.score != null) properties.diagnostix_pricing_score = report.pillars.pa.score;
  if (report?.pillars?.es?.score != null) properties.diagnostix_employee_sentiment_score = report.pillars.es.score;

  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: subscriber.email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results?.[0]?.id;

    if (contactId) {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties })
      });
      console.log('[hubspot-ctx] Updated', subscriber.email, '|', subscriber.plan_type, '| report', reportNumber, '| score', score);
    } else {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties })
      });
      console.log('[hubspot-ctx] Created', subscriber.email, '|', subscriber.plan_type);
    }
  } catch(e) {
    console.log('[hubspot-ctx] Push failed for', subscriber.email, e.message);
  }
}

// Fire-and-forget update of last_engaged_at when a report is viewed.
async function pushLastEngaged(email) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results?.[0]?.id;
    if (!contactId) return;
    await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ properties: { diagnostix_last_engaged_at: new Date().toISOString().split('T')[0] } })
    });
  } catch(e) { /* best-effort */ }
}

// ── CUSTOMER WELCOME / REPORT EMAIL ──────────────────────────
async function sendCustomerReportEmail({ subscriber, report, reportNumber }) {
  const baseUrl = process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app';
  const link = baseUrl + '/report?token=' + subscriber.report_token;
  const score = report?.healthCheckScore ?? 0;
  const verdict = report?.scoreVerdict || '';
  const restaurant = subscriber.restaurant_name || 'your restaurant';
  const firstName = subscriber.first_name || 'there';
  const isOneOff = subscriber.plan_type === 'one_off';

  let subject, headline, intro;
  if (isOneOff) {
    subject = `Your DiagnostiX Full Report is ready — ${restaurant}`;
    headline = 'Your DiagnostiX Full Report is ready';
    intro = 'Thank you for purchasing the DiagnostiX Full Report. Your full HealthCheck is now permanently available at the link below — bookmark it for future reference. If you would like ongoing tracking with reports every 4 months, you can upgrade to DiagnostiX Annual at any time.';
  } else if (reportNumber === 1) {
    subject = `Welcome to DiagnostiX Annual — your baseline report for ${restaurant}`;
    headline = 'Your DiagnostiX baseline is ready';
    intro = 'Thank you for subscribing to DiagnostiX Annual. Your baseline report is now stored and ready to view anytime over the next 12 months. We will send you Report 2 in 4 months and Report 3 in 8 months automatically.';
  } else if (reportNumber === 2) {
    subject = `Your DiagnostiX Report 2 is ready — ${restaurant}`;
    headline = 'Your Month 4 progress report is ready';
    intro = 'Four months on from your baseline, your second DiagnostiX report is ready. The link below shows your latest scores side-by-side with your baseline so you can see exactly what is moving.';
  } else {
    subject = `Your DiagnostiX Year-End Report is ready — ${restaurant}`;
    headline = 'Your year-end DiagnostiX report is ready';
    intro = 'Your third and final DiagnostiX report of this year is ready. Inside you will find a year-end side-by-side comparison of all three reports across every pillar.';
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f4f7fa;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0a2540">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="font-weight:700;letter-spacing:.5px;color:#0a2540;font-size:14px;padding:8px 0 16px">DIAGNOSTIX</div>
  <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(10,37,64,.06)">
    <h1 style="font-size:24px;margin:0 0 8px">${headline}</h1>
    <p style="font-size:15px;line-height:1.6;color:#374151;margin:8px 0 24px">Hi ${firstName}, ${intro}</p>
    <div style="background:#f4f7fa;border-radius:10px;padding:20px;text-align:center;margin:8px 0 24px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280">Overall score</div>
      <div style="font-size:56px;font-weight:800;color:#2e75b6;line-height:1;margin:8px 0">${score}<span style="font-size:24px;color:#6b7280">/100</span></div>
      <div style="font-size:14px;color:#6b7280">${verdict}</div>
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="${link}" style="display:inline-block;background:#2e75b6;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px">View your full report</a>
    </div>
    <p style="font-size:13px;color:#6b7280;line-height:1.5;margin:24px 0 0">Or paste this link into your browser:<br><span style="color:#0a2540;word-break:break-all">${link}</span></p>
  </div>
  <div style="text-align:center;font-size:12px;color:#6b7280;padding:24px">DiagnostiX by 4xi360 · This link is private to you. Keep it safe.</div>
</div></body></html>`;

  return await sendEmailViaResend({
    to: subscriber.email, subject, html, fromName: 'DiagnostiX'
  });
}

// ── /report VIEWER ───────────────────────────────────────────
app.get('/report', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token || token.length < 16) {
    return res.status(400).send(renderErrorPage(
      'Invalid link',
      'This report link is malformed. Please use the link from your DiagnostiX welcome email.'
    ));
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  try {
    const r = await fetch(
      url + '/rest/v1/subscribers?report_token=eq.' + encodeURIComponent(token) + '&select=*',
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key } }
    );
    const rows = await r.json();
    const sub = Array.isArray(rows) ? rows[0] : null;
    if (!sub) {
      return res.status(404).send(renderErrorPage(
        'Report not found',
        'We could not find a report matching this link. It may have been revoked. Please contact support.'
      ));
    }

    let report = sub.baseline_report;
    let reportLabel = sub.plan_type === 'one_off' ? 'Full Report' : 'Baseline Report (Day 0)';
    if (sub.report_2) { report = sub.report_2; reportLabel = 'Report 2 — Month 4'; }
    if (sub.report_3) { report = sub.report_3; reportLabel = 'Report 3 — Month 8'; }

    pushLastEngaged(sub.email).catch(() => {});

    const html = renderReportHtml({ subscriber: sub, report, reportLabel });
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch(e) {
    console.log('[/report] error:', e.message);
    return res.status(500).send(renderErrorPage(
      'Something went wrong',
      'We could not load your report right now. Please try again in a few minutes.'
    ));
  }
});

function renderErrorPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — DiagnostiX</title>
<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4f7fa;color:#0a2540;
margin:0;padding:40px 20px}.box{max-width:560px;margin:60px auto;background:#fff;border-radius:12px;
padding:40px;box-shadow:0 2px 12px rgba(10,37,64,.08);text-align:center}
h1{font-size:24px;margin:0 0 16px}p{font-size:16px;line-height:1.5;color:#6b7280}
.brand{font-weight:700;letter-spacing:.5px;color:#0a2540;margin-bottom:24px}
</style></head><body><div class="box"><div class="brand">DIAGNOSTIX</div>
<h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function renderReportHtml({ subscriber, report, reportLabel }) {
  const score = report?.healthCheckScore ?? 0;
  const verdict = report?.scoreVerdict || '';
  const restaurant = subscriber.restaurant_name || 'Your restaurant';
  const pillars = Object.entries(report?.pillars || {});

  const pillarRows = pillars.map(([k, p]) => `
    <tr><td style="padding:10px 14px;border-bottom:1px solid #eee">${p.label||k}</td>
    <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:center;font-weight:700">${p.score}/100</td>
    <td style="padding:10px 14px;border-bottom:1px solid #eee;font-size:12px;color:#6b7280;text-transform:uppercase">${p.status||''}</td></tr>`).join('');

  const actions = (report?.actions || []).map(a => `
    <li style="margin:8px 0"><strong>${a.title}</strong> — <span style="color:#6b7280">${a.desc||''}</span></li>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${restaurant} — DiagnostiX Report</title>
<style>
body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4f7fa;color:#0a2540;margin:0}
.wrap{max-width:760px;margin:0 auto;padding:24px}
.card{background:#fff;border-radius:12px;padding:32px;margin:16px 0;box-shadow:0 2px 12px rgba(10,37,64,.06)}
.brand{font-weight:700;letter-spacing:.5px;color:#0a2540;font-size:14px;margin-bottom:8px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:24px 0 12px;color:#0a2540}
.score{font-size:64px;font-weight:800;color:#2e75b6;line-height:1}
.verdict{font-size:16px;color:#6b7280;margin-top:4px}
.label{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:14px}
.summary{font-size:15px;line-height:1.6;color:#374151}
ul{padding-left:20px}
.footer{text-align:center;font-size:12px;color:#6b7280;padding:24px}
</style></head><body><div class="wrap">
  <div class="card">
    <div class="brand">DIAGNOSTIX · ${reportLabel}</div>
    <h1>${restaurant}</h1>
    <div class="label" style="margin-top:24px">Overall HealthCheck Score</div>
    <div class="score">${score}<span style="font-size:28px;color:#6b7280">/100</span></div>
    <div class="verdict">${verdict}</div>
    <p class="summary" style="margin-top:24px">${report?.executiveSummary || ''}</p>
  </div>
  <div class="card"><h2>Pillar scores</h2><table>${pillarRows}</table></div>
  ${actions ? '<div class="card"><h2>Recommended actions</h2><ul>' + actions + '</ul></div>' : ''}
  <div class="footer">DiagnostiX by 4xi360 · This link is private to ${subscriber.email}</div>
</div></body></html>`;
}

// ── CREATE CUSTOMER (Annual or one-off) ──────────────────────
async function createCustomer({ email, firstName, restaurantName, location, website, report, survey, planType, amountPaid }) {
  const reportToken = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const isAnnual = planType === 'annual';

  const subscriber = {
    email,
    firstName: firstName || '',
    restaurantName: restaurantName || '',
    location: location || '',
    website: website || '',
    subscribedAt: now,
    planType,
    amountPaid: amountPaid || 0,
    reportToken,
    reports: [{ generatedAt: now, report, survey, reportNumber: 1 }],
    nextReportAt: isAnnual ? now + (4 * 30 * 24 * 60 * 60 * 1000) : null
  };

  if (isAnnual) {
    annualSubscribers.set(email.toLowerCase(), subscriber);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) {
    try {
      await fetch(url + '/rest/v1/subscribers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          first_name:      firstName || null,
          restaurant_name: restaurantName || null,
          location:        location || null,
          website:         website || null,
          subscribed_at:   new Date(now).toISOString(),
          next_report_at:  isAnnual ? new Date(subscriber.nextReportAt).toISOString() : null,
          reports_sent:    1,
          active:          isAnnual,
          plan_type:       planType,
          amount_paid:     amountPaid || 0,
          baseline_score:  report?.healthCheckScore || 0,
          baseline_report: report || null,
          report_token:    reportToken
        })
      });
      console.log('[customer] saved', planType, email, '| token:', reportToken);
    } catch(e) {
      console.log('[customer] Supabase save failed:', e.message);
    }
  }

  return subscriber;
}

// ── /payment-webhook ─────────────────────────────────────────
app.post('/payment-webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  console.log('[webhook] Received body:', JSON.stringify(req.body));
  console.log('[webhook] Current report store keys:', Array.from(reportStore.keys()));

  const body = req.body;
  if (!body) {
    console.log('[webhook] Empty body received');
    return;
  }

  const payload = body.data || body;
  const email = (payload.email || payload.Email || payload.contactEmail || body.email || '').toLowerCase().trim();
  const product = payload.product || payload.Product || body.product || 'full';
  const firstName = payload.firstName || payload.first_name || body.firstName || '';

  if (!email) {
    console.log('[webhook] No email found in body:', JSON.stringify(body));
    return;
  }

  console.log('[webhook] Looking up email:', email);

  let saved = reportStore.get(email);
  if (!saved) {
    for (const [k, v] of reportStore.entries()) {
      if (k.includes(email.split('@')[0]) || email.includes(k.split('@')[0])) {
        saved = v;
        console.log('[webhook] Found report via partial match:', k, '->', email);
        break;
      }
    }
  }

  if (!saved) {
    console.log('[webhook] No saved report for:', email, '| Store has:', reportStore.size, 'entries');
    await markPurchasedAndEmail(email, firstName || '', payload.restaurantName || '', {}, product);
    return;
  }

  const report     = saved.report || {};
  const survey     = saved.survey || {};
  const resolvedFirstName = firstName || survey.contactName || survey.firstName || '';
  const restaurant = survey.name || body.restaurantName || '';
  const location   = survey.location || '';

  console.log('[webhook] Payment confirmed for:', email, product, '| Restaurant:', restaurant);

  // Legacy HubSpot purchase marker (kept for backward compatibility).
  await markPurchasedAndEmail(email, resolvedFirstName, restaurant, report, product);

  if (!report || Object.keys(report).length === 0) {
    console.log('[webhook] No report data — skipping full customer creation');
    return;
  }

  // Unified flow: both Annual and one-off go through createCustomer.
  const planType = product === 'annual' ? 'annual' : 'one_off';
  const amountPaid = planType === 'annual' ? 99.99 : Number(payload.amountPaid || payload.amount || 24.99);

  const subscriber = await createCustomer({
    email,
    firstName: resolvedFirstName,
    restaurantName: restaurant,
    location: survey.location || '',
    website:  survey.website  || '',
    report,
    survey,
    planType,
    amountPaid
  });

  const supaShaped = {
    email:           subscriber.email,
    first_name:      subscriber.firstName,
    restaurant_name: subscriber.restaurantName,
    plan_type:       subscriber.planType,
    amount_paid:     subscriber.amountPaid,
    active:          planType === 'annual',
    subscribed_at:   new Date(subscriber.subscribedAt).toISOString(),
    next_report_at:  subscriber.nextReportAt ? new Date(subscriber.nextReportAt).toISOString() : null,
    report_token:    subscriber.reportToken
  };

  const reportUrl = (process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app')
                   + '/report?token=' + subscriber.reportToken;

  await Promise.all([
    sendCustomerReportEmail({ subscriber: supaShaped, report, reportNumber: 1 }),
    pushReportContextToHubSpot({ subscriber: supaShaped, report, reportNumber: 1, reportUrl, baseline: report })
  ]);

  console.log('[webhook] Full flow complete for', email, '| plan:', planType);
});

// ── GET SUBSCRIBER FROM SUPABASE ─────────────────────────────
async function getSubscriberFromSupabase(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(url + '/rest/v1/subscribers?email=eq.' + encodeURIComponent(email) + '&select=*', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
  } catch(e) {
    console.log('[supabase] getSubscriber failed:', e.message);
    return null;
  }
}

// ── UPDATE SUBSCRIBER IN SUPABASE (Reports 2/3) ──────────────
async function updateSubscriberInSupabase(sub, reportNumber) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    const latest = sub.reports[sub.reports.length - 1]?.report || null;
    const body = {
      reports_sent:   reportNumber,
      next_report_at: sub.nextReportAt ? new Date(sub.nextReportAt).toISOString() : null,
      active:         sub.nextReportAt ? true : false,
      latest_score:   latest?.healthCheckScore || 0
    };
    if (reportNumber === 2) {
      body.report_2 = latest;
      body.report_2_score = latest?.healthCheckScore || 0;
      body.report_2_date = new Date().toISOString();
    } else if (reportNumber === 3) {
      body.report_3 = latest;
      body.report_3_score = latest?.healthCheckScore || 0;
      body.report_3_date = new Date().toISOString();
    }
    await fetch(`${url}/rest/v1/subscribers?email=eq.${encodeURIComponent(sub.email)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body)
    });
    console.log('[supabase] Subscriber updated:', sub.email, 'report', reportNumber);
  } catch(e) {
    console.log('[supabase] Subscriber update failed:', e.message);
  }
}

// ── GENERATE PROGRESS REPORT (Reports 2 and 3) ───────────────
async function generateProgressReport(sub) {
  const { email, restaurantName, location } = sub;
  const baseline = sub.reports[0];
  const previous = sub.reports[sub.reports.length - 1];
  const reportNumber = sub.reports.length + 1;

  console.log('[annual] Generating report', reportNumber, 'for:', email);

  try {
    const [g, rv, st, so, dl, co] = await Promise.all([
      search(`"${restaurantName}" ${location} restaurant`),
      search(`"${restaurantName}" ${location} reviews TripAdvisor Yelp OpenTable`),
      search(`"${restaurantName}" Glassdoor Indeed employees`),
      search(`"${restaurantName}" Instagram Facebook social media`),
      search(`"${restaurantName}" Uber Eats DoorDash delivery`),
      search(`best restaurants ${location} competitors ${restaurantName}`)
    ]);
    const web = `GOOGLE:${g}\nREVIEWS:${rv}\nSTAFF:${st}\nSOCIAL:${so}\nDELIVERY:${dl}\nCOMPETITORS:${co}`;

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

    const p1 = await claude(`Restaurant:${restaurantName}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${baselineCtx}\n${prevCtx}\n\nThis is report ${reportNumber} of 3 for an annual subscriber. Return JSON:\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings and progress vs baseline","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":""},{"name":"Yelp","score":65,"note":""},{"name":"TripAdvisor","score":55,"note":""},{"name":"OpenTable","score":60,"note":""},{"name":"Social Media","score":50,"note":""},{"name":"Delivery Platforms","score":35,"note":""}]},"ownerSentimentSummary":"","sentimentGap":""}\nRules:good>=65 warn=45-64 bad<45`);

    const p2 = await claude(`Restaurant:${restaurantName}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${baselineCtx}\n\nReturn JSON with progress tracking:\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":3,"sentiment":"negative"}],"strengths":["strength 1","strength 2","strength 3"],"risks":["risk 1","risk 2","risk 3"],"themes":{"positive":["t1","t2"],"negative":["t1"],"neutral":["t1"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real","score":68,"note":""},{"name":"real","score":62,"note":""},{"name":"real","score":71,"note":""}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}],"progress":{"overallChange":${(p1.healthCheckScore||70) - baseline.report.healthCheckScore},"pillarsProgress":{"cs":${(p1.pillars?.cs?.score||70) - (baseline.report.pillars?.cs?.score||70)},"pa":${(p1.pillars?.pa?.score||65) - (baseline.report.pillars?.pa?.score||65)},"es":${(p1.pillars?.es?.score||50) - (baseline.report.pillars?.es?.score||50)},"sm":${(p1.pillars?.sm?.score||55) - (baseline.report.pillars?.sm?.score||55)},"cp":${(p1.pillars?.cp?.score||70) - (baseline.report.pillars?.cp?.score||70)},"bg":${(p1.pillars?.bg?.score||65) - (baseline.report.pillars?.bg?.score||65)}},"completedActions":[],"ongoingPriorities":[],"progressNarrative":"2 sentences on what has improved and what still needs work"}}`);

    const report = Object.assign({}, p1, p2, {
      reportNumber,
      baselineScore: baseline.report.healthCheckScore,
      generatedAt: new Date().toISOString(),
      isProgressReport: true
    });

    sub.reports.push({ generatedAt: Date.now(), report, reportNumber });

    if (reportNumber < 3) {
      sub.nextReportAt = Date.now() + (4 * 30 * 24 * 60 * 60 * 1000);
    } else {
      sub.nextReportAt = null;
      sub.completedAt = Date.now();
    }

    console.log('[annual] Report', reportNumber, 'generated for:', email, '| Score:', report.healthCheckScore);

    // Save to Supabase.
    await updateSubscriberInSupabase(sub, reportNumber);

    // Email customer + push HubSpot context, using the canonical Supabase row.
    const refreshed = await getSubscriberFromSupabase(sub.email);
    if (refreshed && refreshed.report_token) {
      const reportUrl = (process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app')
                       + '/report?token=' + refreshed.report_token;
      await Promise.all([
        sendCustomerReportEmail({ subscriber: refreshed, report, reportNumber }),
        pushReportContextToHubSpot({
          subscriber:    refreshed,
          report,
          reportNumber,
          reportUrl,
          baseline:      refreshed.baseline_report
        })
      ]);
    } else {
      console.log('[annual] Skipping email/HubSpot — no token for', sub.email);
    }

    return report;
  } catch(e) {
    console.log('[annual] Report generation failed for:', email, e.message);
  }
}

// ── LOAD SUBSCRIBERS FROM SUPABASE ON STARTUP ────────────────
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
          reports:        [{ generatedAt: new Date(row.subscribed_at).getTime(), report: row.baseline_report || { healthCheckScore: row.baseline_score || 0, pillars: {} }, reportNumber: 1 }]
        });
      });
      console.log('[annual] Loaded', rows.length, 'active subscribers from Supabase');
    }
  } catch(e) {
    console.log('[annual] Failed to load subscribers from Supabase:', e.message);
  }
}
loadSubscribersFromSupabase();

// ── DAILY SCHEDULER — check every 6 hours ────────────────────
setInterval(async () => {
  const now = Date.now();
  console.log('[scheduler] Checking', annualSubscribers.size, 'subscribers for due reports...');
  for (const [email, sub] of annualSubscribers.entries()) {
    if (sub.nextReportAt && now >= sub.nextReportAt) {
      console.log('[scheduler] Report due for:', email);
      await generateProgressReport(sub);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}, 6 * 60 * 60 * 1000);

// ── MANUAL TRIGGER (for testing) ─────────────────────────────
app.post('/trigger-annual-report', async (req, res) => {
  const { email, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const sub = annualSubscribers.get((email||'').toLowerCase());
  if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
  res.status(200).json({ ok: true, message: 'Report generation started' });
  await generateProgressReport(sub);
});

app.listen(PORT, () => console.log(`DiagnostiX v8 on port ${PORT}`));
