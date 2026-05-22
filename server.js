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
async function sendEmailViaResend({ to, subject, html, fromName, bcc }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'reports@4xi360.com';
  if (!key) {
    console.log('[email] RESEND_API_KEY missing — skipping send to', to);
    return { ok: false, reason: 'missing key' };
  }

  const payload = {
    from: (fromName || 'DiagnostiX') + ' <' + from + '>',
    to: [to],
    subject,
    html
  };
  if (bcc && bcc.length) {
    payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
  }

  // Single attempt — returns one of: {ok:true,id}, {ok:false,reason,retryable:bool}
  async function attempt() {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // Resend usually returns JSON, but on timeouts/rate-limits/5xx it can
      // return HTML/text. Read as text first, then try to parse safely.
      const rawBody = await r.text();
      let d;
      try {
        d = rawBody ? JSON.parse(rawBody) : {};
      } catch(parseErr) {
        // Non-JSON response → almost always a transient infra issue (408, 502, 503, 504).
        const retryable = r.status === 408 || r.status === 429 || (r.status >= 500 && r.status < 600);
        console.log('[email] Resend returned non-JSON (status ' + r.status + '):', rawBody.slice(0, 200));
        return { ok: false, reason: 'non-json response (status ' + r.status + ')', retryable };
      }

      if (d.id) {
        return { ok: true, id: d.id };
      }
      // JSON error response — retryable if status code indicates transient issue.
      const retryable = r.status === 408 || r.status === 429 || (r.status >= 500 && r.status < 600);
      console.log('[email] Resend rejected (status ' + r.status + '):', JSON.stringify(d));
      return { ok: false, reason: d.message || d.error || 'unknown', retryable };
    } catch(e) {
      // Network failure (fetch threw) — always worth one retry.
      console.log('[email] send failed:', e.message);
      return { ok: false, reason: e.message, retryable: true };
    }
  }

  // First attempt
  let result = await attempt();
  if (result.ok) {
    console.log('[email] sent to', to, bcc ? '| bcc: ' + (Array.isArray(bcc) ? bcc.join(',') : bcc) : '', '| id:', result.id);
    return result;
  }

  // Retry once on transient errors after a 2s backoff
  if (result.retryable) {
    console.log('[email] transient failure — retrying in 2s:', result.reason);
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = await attempt();
    if (result.ok) {
      console.log('[email] sent to', to, bcc ? '| bcc: ' + (Array.isArray(bcc) ? bcc.join(',') : bcc) : '', '| id:', result.id, '(after retry)');
      return result;
    }
    console.log('[email] retry also failed:', result.reason);
  }

  return result;
}

// ── INTERNAL SUMMARY EMAIL ───────────────────────────────────
// Sent to hello@4xiconsulting.com alongside every customer report.
// Compact plain-text-style summary for at-a-glance triage in inbox.
async function sendInternalSummaryEmail({ subscriber, report, reportNumber, survey }) {
  const INTERNAL_TO = 'hello@4xiconsulting.com';
  const baseUrl = process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app';
  const link = baseUrl + '/report?token=' + subscriber.report_token;
  const score = report?.healthCheckScore ?? 0;
  const verdict = report?.scoreVerdict || '';
  const restaurant = subscriber.restaurant_name || '(unknown)';
  const location = (survey && survey.location) || subscriber.location || '';
  const cuisine = (survey && survey.cuisine) || '';
  const price = (survey && survey.price) || '';
  const ownerName = subscriber.first_name || '';
  const ownerEmail = subscriber.email || '';
  const isOneOff = subscriber.plan_type === 'one_off';

  // Subject: [DiagnostiX] New {full|annual} report: {restaurant} ({location}) — Score {score}
  const planLabel = isOneOff ? 'full' : 'annual';
  const reportTag = isOneOff
    ? 'Full Report ($49.99)'
    : `Annual Subscription ($99.99) — Report ${reportNumber || 1} of 3`;
  const subject = `[DiagnostiX] New ${planLabel} report: ${restaurant}${location ? ' (' + location + ')' : ''} — Score ${score}`;

  // Pillars summary
  const pillars = Object.values(report?.pillars || {});
  const pillarRows = pillars.map(p =>
    `  ${(p.label || '').padEnd(28)} ${p.score}`
  ).join('\n');

  const escE = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Plain-text body wrapped in minimal HTML (so Resend accepts + email clients render mono-friendly)
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;padding:24px 28px;border-radius:8px;border:1px solid #e5e5e5">
  <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;color:#1B1464;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;border-bottom:2px solid #92278F;padding-bottom:10px">
    DiagnostiX · Internal Summary
  </div>
  <div style="font-size:14px;line-height:1.7;color:#222">
    <strong>Restaurant:</strong> ${escE(restaurant)}<br>
    <strong>Location:</strong> ${escE(location || '—')}<br>
    ${cuisine ? `<strong>Cuisine:</strong> ${escE(cuisine)}<br>` : ''}
    ${price ? `<strong>Price:</strong> ${escE(price)}<br>` : ''}
    <strong>Owner:</strong> ${escE(ownerName || '—')} (${escE(ownerEmail)})<br>
    <strong>Plan:</strong> ${escE(reportTag)}<br>
    <br>
    <strong>Overall Score:</strong> <span style="font-weight:900;color:${score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24'}">${score} / 100</span> ${verdict ? '— ' + escE(verdict) : ''}<br>
    <br>
    <strong>Pillars:</strong>
    <pre style="font-family:'SF Mono',Consolas,Menlo,monospace;font-size:13px;background:#f7f5f0;padding:12px 14px;border-radius:6px;margin:6px 0 14px;white-space:pre-wrap">${escE(pillarRows || '(none)')}</pre>
    <a href="${link}" style="display:inline-block;background:#1B1464;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:700;font-size:13px;letter-spacing:0.5px">View Full Report &rarr;</a>
    <div style="margin-top:14px;font-size:11px;color:#888;word-break:break-all">${link}</div>
  </div>
</div>
</body></html>`;

  return await sendEmailViaResend({
    to: INTERNAL_TO,
    subject,
    html,
    fromName: 'DiagnostiX Internal'
  });
}

// ── ROOT + HEALTH + TEST ─────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.json({ status: 'running', version: '8.2' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '8.2' });
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

    // Build optional business-metrics block. Operators self-report year-over-year changes.
    // Financial metrics arrive as sliders — always have a value (default 0 = "same as last year").
    // We still defensively coerce in case of missing field; treat null/undefined as 0.
    const bm = body.businessMetrics || {};
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
    const guestN  = num(bm.guestCountChange);
    const checkN  = num(bm.avgCheckChange);
    const profitN = num(bm.profitabilityChange);
    const fmtPct = (v) => (v >= 0 ? '+' : '') + v + '%';
    const bmBlock = `OWNER-REPORTED BUSINESS METRICS (year-over-year change, from sliders — default 0 means "same as last year"):
- Guest count change:    ${fmtPct(guestN)}
- Average check change:  ${fmtPct(checkN)}
- Profitability change:  ${fmtPct(profitN)}

CRITICAL — INTEGRATE QUALITATIVE WITH QUANTITATIVE:
These financial metrics are TIER-1 evidence (real business reality). You MUST blend them with the qualitative pillar scores and web data to produce holistic findings, not isolated commentary. Examples of the integration we want:
  • If guest count is down but Customer Sentiment pillar is high → "Sentiment among existing customers is strong, but acquisition is failing. The issue isn't the experience, it's getting people through the door."
  • If average check is down but Pricing pillar is high → "Pricing strategy reads well from the menu, but operators aren't capturing the upside in real ticket value — likely an upselling or menu-mix execution gap."
  • If profitability is down but revenue stable → "Top line holds but margins erode — this is a cost-control problem, not a demand problem."
  • If all three are flat (0% / 0% / 0%) → operator likely defaulted the sliders; treat financials as a "stable baseline" signal and lean more on qualitative+web evidence in the analysis.

When writing businessRealityAnalysis: 2-3 sentences that EXPLICITLY weave the financial numbers together with the relevant qualitative pillars. Name the pillars. Show how the numbers either confirm or contradict the qualitative picture.
When writing perceptionGap: 1-2 sentences ONLY if there is a meaningful divergence between owner self-perception and financial reality. If broadly aligned (or all metrics ~0), return empty string "".`;
    console.log('[diagnose] business metrics:', fmtPct(guestN), '|', fmtPct(checkN), '|', fmtPct(profitN));
    console.log('[diagnose] claude part1...');
    const p1 = await claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language.\n\nRestaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${sv}\n\n${bmBlock}\n\nReturn JSON. Use WebData for scores. Use Owner Self-Assessment to write ownerSentimentSummary (2 sentences interpreting what owner thinks vs what data shows) and sentimentGap (1 sentence on biggest gap between owner perception and reality). businessRealityAnalysis and perceptionGap follow the rules above. When business metrics are provided, ALSO populate pillarGapNarratives with one short sentence per relevant pairing (guest count ↔ Customer Sentiment pillar; average check ↔ Pricing & Accessibility pillar; profitability ↔ Brand Experience & Growth pillar). Each narrative should be 1 punchy sentence interpreting the gap or alignment between the financial metric and the qualitative pillar score. If a metric is not provided, return empty string "" for its narrative.\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"from data","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real"},{"name":"Yelp","score":65,"note":"real"},{"name":"TripAdvisor","score":55,"note":"real"},{"name":"OpenTable","score":60,"note":"real"},{"name":"Social Media","score":50,"note":"real"},{"name":"Delivery Platforms","score":35,"note":"real"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence","businessRealityAnalysis":"","perceptionGap":"","pillarGapNarratives":{"guest":"","check":"","profit":""}}\nRules:good>=65 warn=45-64 bad<45 scoreVerdict=Excellent/Good/Fair/Needs Attention. NOTE: Do NOT change the healthCheckScore or pillar scores based on businessMetrics — the score remains qualitative+web-data driven. Financial metrics are reported separately via businessRealityAnalysis, perceptionGap, and pillarGapNarratives.`);
    console.log('[diagnose] p1 score:', p1.healthCheckScore);
    console.log('[diagnose] claude part2...');
    const p2 = await claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language. Translate any non-English review quotes into English.\n\nRestaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${bmBlock}\n\nReturn JSON with real data.\n\nIMPORTANT — TWO DISTINCT ACTION LISTS:\n1. "actions" — 5 OPERATIONAL recommendations driven by the qualitative pillars and web data (customer experience, staff, social media, brand, competitive positioning). These exist regardless of whether financial metrics were provided. Do NOT mention specific financial numbers in these actions.\n2. "commercialActions" — 2-3 COMMERCIAL/FINANCIAL recommendations driven specifically by the business metrics provided. Only populate when at least one metric is given; return empty array [] if none provided. Each item must include "title", "desc", and "evidence" (a short phrase referencing the specific financial metric that drove the recommendation, e.g. "Guest count -12% YoY" or "Profitability -8% YoY").\n\nCommercial action guidance: declining guest count → acquisition/awareness/traffic actions; declining average check → menu mix, pricing strategy, upselling actions; declining profitability with stable revenue → cost control, prime cost management, supplier/labor optimization. Strong growth → reinvestment/expansion suggestions.\n\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["real strength 1","real strength 2","real strength 3"],"risks":["real risk 1","real risk 2","real risk 3"],"themes":{"positive":["t1","t2","t3"],"negative":["t1","t2"],"neutral":["t1","t2"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real","score":68,"note":"data"},{"name":"real","score":62,"note":"data"},{"name":"real","score":71,"note":"data"}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based, operational"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}],"commercialActions":[{"title":"t","desc":"d","evidence":"financial metric reference"},{"title":"t","desc":"d","evidence":"financial metric reference"}]}`);
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
async function sendCustomerReportEmail({ subscriber, report, reportNumber, survey }) {
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

  // Score color matches the survey banding (green ≥65, amber ≥45, red <45)
  const scoreColor = score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24';
  const escE = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escE(subject)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=League+Spartan:wght@300;400;500;700;900&display=swap');
</style>
</head>
<body style="margin:0;padding:0;background:#F5F4FC;font-family:'League Spartan',-apple-system,Segoe UI,Arial,sans-serif;color:#1B1464;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F5F4FC">
<tr><td align="center" style="padding:24px 12px">

  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%">

    <!-- Purple gradient header -->
    <tr><td style="background:#1B1464;background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);border-radius:14px 14px 0 0;padding:32px 32px 28px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;letter-spacing:1px;color:#ffffff;font-size:22px;line-height:1">diagnosti<span style="color:#0072BC">X</span></div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:rgba(255,255,255,.75);text-transform:uppercase;margin-top:4px;font-weight:500">Restaurant HealthCheck · by 4xi</div>
        </td></tr>
        <tr><td style="padding-top:28px">
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:3px;color:rgba(255,255,255,.7);text-transform:uppercase;font-weight:700">Performance Intelligence Report</div>
          <div style="font-family:'League Spartan',Arial,sans-serif;color:#ffffff;font-size:26px;font-weight:900;line-height:1.2;margin-top:6px">${escE(restaurant)}</div>
        </td></tr>
      </table>
    </td></tr>

    <!-- Gold/blue gradient divider -->
    <tr><td style="height:4px;background:#0072BC;background-image:linear-gradient(90deg,#92278F,#0072BC);font-size:0;line-height:0">&nbsp;</td></tr>

    <!-- White content body -->
    <tr><td style="background:#ffffff;padding:32px;border-radius:0 0 14px 14px">

      <div style="font-family:'League Spartan',Arial,sans-serif;font-size:20px;font-weight:900;color:#1B1464;margin:0 0 14px;line-height:1.25">${escE(headline)}</div>
      <p style="font-family:'League Spartan',Arial,sans-serif;font-size:14px;line-height:1.65;color:#444;margin:0 0 24px;font-weight:400">Hi ${escE(firstName)}, ${escE(intro)}</p>

      <!-- Score block -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F5F4FC;border-radius:10px;margin:0 0 28px">
        <tr><td align="center" style="padding:22px 18px">
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:#1B1464;text-transform:uppercase;font-weight:700;opacity:.7">Overall HealthCheck Score</div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:54px;font-weight:900;color:${scoreColor};line-height:1;margin:10px 0 4px">${score}<span style="font-size:20px;color:#999;font-weight:500">/100</span></div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:13px;color:#1B1464;font-weight:700;letter-spacing:1px;text-transform:uppercase">${escE(verdict)}</div>
        </td></tr>
      </table>

      <!-- CTA button -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td align="center" style="padding:0 0 8px">
          <a href="${link}" style="display:inline-block;background:#1B1464;background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);color:#ffffff;text-decoration:none;padding:16px 36px;border-radius:8px;font-family:'League Spartan',Arial,sans-serif;font-weight:900;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;mso-padding-alt:0">View Your Full Report &rarr;</a>
        </td></tr>
      </table>

      <p style="font-family:'League Spartan',Arial,sans-serif;font-size:12px;color:#999;line-height:1.6;margin:28px 0 0;text-align:center">Or paste this link into your browser:<br><span style="color:#1B1464;word-break:break-all;font-weight:500">${link}</span></p>

    </td></tr>
  </table>

  <!-- Footer -->
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;margin-top:8px">
    <tr><td align="center" style="padding:20px 24px;font-family:'League Spartan',Arial,sans-serif;font-size:11px;color:#999;line-height:1.6;letter-spacing:.5px">
      <div style="font-weight:900;color:#1B1464;letter-spacing:1px;text-transform:uppercase;font-size:10px">DiagnostiX by 4xi</div>
      <div style="margin-top:4px">24/7 · 365 Intelligence Platform</div>
      <div style="margin-top:10px;opacity:.8">This link is private to you. Keep it safe.</div>
    </td></tr>
  </table>

</td></tr></table>
</body></html>`;

  // Send customer email (with BCC to internal address) first, then fire compact internal summary.
  // Sequential with a small pause to stay safely under Resend's 2/sec rate limit on the free tier.
  // Internal summary failures are logged but do NOT affect the customer email result.
  const INTERNAL_BCC = 'hello@4xiconsulting.com';
  const customerResult = await sendEmailViaResend({
    to: subscriber.email,
    subject,
    html,
    fromName: 'DiagnostiX',
    bcc: [INTERNAL_BCC]
  });

  // Fire-and-forget the internal summary — don't block return, don't propagate failure.
  setTimeout(() => {
    sendInternalSummaryEmail({ subscriber, report, reportNumber, survey })
      .catch(e => console.log('[email-internal] failed:', e.message));
  }, 600);

  return customerResult;
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
  const restaurant = subscriber.restaurant_name || 'Your restaurant';
  const score      = report?.healthCheckScore ?? 0;
  const verdict    = report?.scoreVerdict || '';
  const summary    = report?.executiveSummary || '';
  const cuisine    = report?.cuisineDetected || '';
  const price      = report?.priceDetected || '';
  const location   = subscriber.location || '';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Survey banding: green ≥65, amber ≥45, red <45
  const scoreColor = score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24';

  // Circular score gauge SVG (matches survey's dialSVG)
  const r = 48, cx = 56, cy = 56;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  const gaugeSvg = `<svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true" style="display:block">
    <defs>
      <filter id="scoreShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.35"/>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${scoreColor}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy+2}" text-anchor="middle" dominant-baseline="middle"
      font-family="League Spartan, Arial, sans-serif" font-weight="900" font-size="30" fill="#ffffff" filter="url(#scoreShadow)">${score}</text>
    <text x="${cx}" y="${cy+22}" text-anchor="middle" dominant-baseline="middle"
      font-family="League Spartan, Arial, sans-serif" font-weight="700" font-size="9" letter-spacing="1.5" fill="#ffffff" opacity="0.85">/ 100</text>
  </svg>`;

  // Pillars — score-bar rows like survey's .sc-row
  const pillars = Object.values(report?.pillars || {});
  const statusColor = (s) => s === 'good' ? '#00A651' : s === 'bad' ? '#ED1C24' : '#F7941D';
  const pillarRows = pillars.map(p => {
    const c = statusColor(p.status);
    const pct = Math.max(0, Math.min(100, p.score || 0));
    return `<div class="sc-row">
      <div class="sc-label">${esc(p.label)}</div>
      <div class="sc-bar"><div class="sc-fill" style="width:${pct}%;background:${c}"></div></div>
      <div class="sc-num" style="color:${c}">${p.score}</div>
    </div>`;
  }).join('');

  // Strengths / risks
  const strengths = (report?.strengths || []).map(s =>
    `<li>${esc(s)}</li>`).join('');
  const risks = (report?.risks || []).map(rr =>
    `<li>${esc(rr)}</li>`).join('');

  // Themes as tag pills
  const tagClass = (kind) => kind === 'positive' ? 'tag-pos' : kind === 'negative' ? 'tag-neg' : 'tag-neu';
  const themeBlock = (label, items, kind) => {
    if (!items || !items.length) return '';
    const chips = items.map(t => `<span class="tag ${tagClass(kind)}">${esc(t)}</span>`).join('');
    return `<div class="theme-row"><div class="theme-label">${label}</div><div class="theme-chips">${chips}</div></div>`;
  };
  const themes = report?.themes || {};
  const themesHtml = themeBlock('Positive', themes.positive, 'positive')
                   + themeBlock('Negative', themes.negative, 'negative')
                   + themeBlock('Neutral',  themes.neutral,  'neutral');

  // Review verbatims
  const verbatims = (report?.reviewVerbatims || []).map(rv => {
    const kind = rv.sentiment === 'positive' ? 'pos' : rv.sentiment === 'negative' ? 'neg' : 'neu';
    const stars = (rv.stars && rv.stars > 0) ? '★'.repeat(rv.stars) + '☆'.repeat(5 - rv.stars) : '';
    return `<div class="qblock qblock-${kind}">
      <div class="qtext">&ldquo;${esc(rv.text)}&rdquo;</div>
      <div class="qmeta">
        ${esc(rv.source || '')}
        ${stars ? '<span class="qstars">' + stars + '</span>' : ''}
        ${rv.sentiment ? '<span class="tag ' + tagClass(rv.sentiment) + '" style="margin-left:6px">' + esc(rv.sentiment) + '</span>' : ''}
      </div>
    </div>`;
  }).join('');

  // Competitors as cards
  const competitors = (report?.competitors || []).map((c, i) => {
    const isMe = i === 0;
    return `<div class="comp-card ${isMe ? 'comp-me' : 'comp-peer'}">
      <div class="comp-name">${esc(c.name)}</div>
      <div class="comp-score">${c.score > 0 ? c.score : '—'}<span class="comp-score-out">/100</span></div>
      <div class="comp-note">${esc(c.note || '')}</div>
    </div>`;
  }).join('');

  // Online presence channels
  const onlineChannels = (report?.onlinePresence?.channels || []).map(c => {
    const cColor = c.score >= 65 ? '#00A651' : c.score >= 45 ? '#F7941D' : '#ED1C24';
    const pct = Math.max(0, Math.min(100, c.score || 0));
    return `<div class="pres-row">
      <div class="pres-name">${esc(c.name)}</div>
      <div class="pres-bar"><div class="pres-fill" style="width:${pct}%;background:${cColor}"></div></div>
      <div class="pres-num" style="color:${cColor}">${c.score}</div>
    </div>`;
  }).join('');
  const onlineOverall = report?.onlinePresence?.overall;

  // Actions grouped by priority
  const priorityLabel = { urgent: 'Urgent', '30days': 'Next 30 Days', ongoing: 'Ongoing' };
  const priorityClass = { urgent: 'pri-hi', '30days': 'pri-med', ongoing: 'pri-lo' };
  const actionsByPriority = {};
  (report?.actions || []).forEach(a => {
    const p = a.priority || 'ongoing';
    if (!actionsByPriority[p]) actionsByPriority[p] = [];
    actionsByPriority[p].push(a);
  });
  let actionNum = 0;
  const actionsHtml = ['urgent', '30days', 'ongoing']
    .filter(p => actionsByPriority[p])
    .map(p => {
      const items = actionsByPriority[p].map(a => {
        actionNum++;
        return `<div class="act">
          <div class="act-num">${String(actionNum).padStart(2,'0')}</div>
          <div class="act-body">
            <div class="act-head">
              <div class="act-title">${esc(a.title)}</div>
              <span class="act-pri ${priorityClass[p]}">${priorityLabel[p]}</span>
            </div>
            <div class="act-desc">${esc(a.desc)}</div>
          </div>
        </div>`;
      }).join('');
      return items;
    }).join('');

  // Owner perception vs reality
  const ownerSummary = report?.ownerSentimentSummary || '';
  const sentimentGap = report?.sentimentGap || '';
  const ownerBlock = (ownerSummary || sentimentGap) ? `
    <h2 class="rpt-h">Owner perception vs reality</h2>
    ${ownerSummary ? '<p class="body-p">' + esc(ownerSummary) + '</p>' : ''}
    ${sentimentGap ? '<div class="gap-block"><div class="gap-label">Gap to close</div><div class="gap-text">' + esc(sentimentGap) + '</div></div>' : ''}
  ` : '';

  // Business reality block — financial metrics + pillar pairings + AI's analysis.
  // Renders only when at least one financial metric is present on the subscriber row.
  // Color bands: red when worse than -5%, amber -5% to 0%, green >= 0%. Profitability widens slightly.
  const guestChg  = (typeof subscriber.guest_count_change   === 'number') ? subscriber.guest_count_change   : null;
  const checkChg  = (typeof subscriber.avg_check_change     === 'number') ? subscriber.avg_check_change     : null;
  const profitChg = (typeof subscriber.profitability_change === 'number') ? subscriber.profitability_change : null;
  const hasAnyBM = guestChg !== null || checkChg !== null || profitChg !== null;
  const businessAnalysis = report?.businessRealityAnalysis || '';
  const perceptionGap    = report?.perceptionGap || '';

  const bandColor = (v, redAt, amberAt) => {
    if (v === null) return '#999';
    if (v <= redAt) return 'var(--red)';
    if (v < amberAt) return 'var(--amber)';
    return 'var(--green)';
  };
  const metricChip = (v, label, redAt, amberAt) => {
    if (v === null) return `
      <div style="flex:1;min-width:170px;background:#f7f5f0;border-radius:8px;padding:12px 14px;border:1px solid #e8e3d8">
        <div style="font-size:10.5px;letter-spacing:1.5px;color:#999;text-transform:uppercase;font-weight:700;margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:18px;font-weight:700;color:#bbb">Not tracked</div>
      </div>`;
    const color = bandColor(v, redAt, amberAt);
    const sign = v >= 0 ? '+' : '';
    return `
      <div style="flex:1;min-width:170px;background:#f7f5f0;border-radius:8px;padding:12px 14px;border-left:4px solid ${color}">
        <div style="font-size:10.5px;letter-spacing:1.5px;color:#666;text-transform:uppercase;font-weight:700;margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:24px;font-weight:900;color:${color};font-family:'League Spartan',Arial,sans-serif">${sign}${v}%</div>
        <div style="font-size:11px;color:#888;margin-top:2px">vs same time last year</div>
      </div>`;
  };

  // Pillar pairing mini-grid — pairs each financial metric with the qualitative pillar
  // most relevant to it. Helps operators see at a glance whether perception matches reality.
  // Pairing logic (justified in the prompt):
  //   Guest count       ↔ Customer Sentiment (cs)
  //   Average check     ↔ Pricing & Accessibility (pa)
  //   Profitability     ↔ Brand Experience & Growth (bg)
  const pp = report?.pillars || {};
  const pillarColor = (s) => s === 'good' ? 'var(--green)' : s === 'bad' ? 'var(--red)' : 'var(--amber)';
  const pillarPairRow = (metricVal, metricLabel, metricRedAt, metricAmberAt, pillarObj, gapNarrative) => {
    if (metricVal === null) return ''; // skip if metric not tracked
    if (!pillarObj || typeof pillarObj.score !== 'number') return '';
    const mColor = bandColor(metricVal, metricRedAt, metricAmberAt);
    const pColor = pillarColor(pillarObj.status);
    const sign = metricVal >= 0 ? '+' : '';
    return `
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:18px;align-items:center;background:#f7f5f0;padding:14px 18px;margin:8px 0;border-radius:8px">
        <div style="text-align:left">
          <div style="font-size:10px;letter-spacing:1.5px;color:#666;text-transform:uppercase;font-weight:700;margin-bottom:4px">${esc(metricLabel)}</div>
          <div style="font-size:22px;font-weight:900;color:${mColor};font-family:'League Spartan',Arial,sans-serif;line-height:1">${sign}${metricVal}%</div>
        </div>
        <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">vs</div>
        <div style="text-align:right">
          <div style="font-size:10px;letter-spacing:1.5px;color:#666;text-transform:uppercase;font-weight:700;margin-bottom:4px">${esc(pillarObj.label || '')}</div>
          <div style="font-size:22px;font-weight:900;color:${pColor};font-family:'League Spartan',Arial,sans-serif;line-height:1">${pillarObj.score}<span style="font-size:13px;color:#999;font-weight:500">/100</span></div>
        </div>
        ${gapNarrative ? '<div style="grid-column:1/-1;font-size:13px;color:#333;line-height:1.6;padding-top:8px;border-top:1px solid #e8e3d8">' + esc(gapNarrative) + '</div>' : ''}
      </div>`;
  };

  // AI provides pillarGapNarratives — one short sentence per pairing explaining the gap
  const pgn = report?.pillarGapNarratives || {};
  const pillarPairings = hasAnyBM ? [
    pillarPairRow(guestChg,  'Guest Count',   -10, 0, pp.cs, pgn.guest),
    pillarPairRow(checkChg,  'Average Check', -3,  0, pp.pa, pgn.check),
    pillarPairRow(profitChg, 'Profitability', -5,  0, pp.bg, pgn.profit)
  ].filter(Boolean).join('') : '';

  const businessRealityBlock = hasAnyBM ? `
    <h2 class="rpt-h">Financial Reality vs Operational Reality</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">
      ${metricChip(guestChg,  'Guest Count',     -10, 0)}
      ${metricChip(checkChg,  'Average Check',   -3,  0)}
      ${metricChip(profitChg, 'Profitability',   -5,  0)}
    </div>
    ${businessAnalysis ? '<p class="body-p" style="margin:8px 0 16px">' + esc(businessAnalysis) + '</p>' : ''}
    ${pillarPairings ? '<div style="margin:14px 0 10px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#666;font-weight:700">Where your numbers and your self-assessment meet</div>' + pillarPairings : ''}
    ${perceptionGap ? '<div class="gap-block" style="background:#fff8ec;border-left:4px solid var(--amber);margin-top:14px"><div class="gap-label" style="color:#a85d00">Perception vs reality</div><div class="gap-text">' + esc(perceptionGap) + '</div></div>' : ''}
  ` : '';

  // Commercial recommendations block — distinct from operational actions.
  // Renders only when AI produced commercialActions AND at least one financial metric was provided.
  const commercialActions = Array.isArray(report?.commercialActions) ? report.commercialActions : [];
  const commercialActionsBlock = (hasAnyBM && commercialActions.length) ? `
    <h2 class="rpt-h">Commercial Recommendations</h2>
    <p class="body-p" style="margin:0 0 14px;color:#666;font-size:13px">Actions tied directly to your financial reality. These complement &mdash; not replace &mdash; the operational actions below.</p>
    ${commercialActions.slice(0, 3).map((a, idx) => {
      const evidence = a.evidence || '';
      return `
        <div style="background:#f7f5f0;border-left:3px solid var(--magenta);padding:18px 22px;margin:10px 0;border-radius:0 8px 8px 0">
          <div style="display:flex;align-items:flex-start;gap:14px">
            <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;font-size:24px;color:var(--magenta);line-height:1;min-width:32px">C${idx + 1}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px;margin-bottom:6px">${esc(a.title || '')}</div>
              <div style="font-size:13.5px;line-height:1.65;color:#444;margin-bottom:8px">${esc(a.desc || '')}</div>
              ${evidence ? '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--magenta);font-weight:700;background:#fbf2fa;padding:6px 10px;border-radius:4px;display:inline-block">Tied to: ' + esc(evidence) + '</div>' : ''}
            </div>
          </div>
        </div>`;
    }).join('')}
  ` : '';

  const metaParts = [cuisine, price, location, reportLabel].filter(Boolean);
  const metaRow = metaParts.map(esc).join(' &nbsp;·&nbsp; ');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(restaurant)} — DiagnostiX Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=League+Spartan:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
:root{
  --navy:#1B1464;
  --navy2:#2E3192;
  --magenta:#92278F;
  --blue:#0072BC;
  --grad:linear-gradient(135deg,#92278F,#2E3192,#1B1464);
  --grad-h:linear-gradient(90deg,#92278F,#0072BC);
  --gold:#0072BC;
  --green:#00A651;
  --amber:#F7941D;
  --red:#ED1C24;
  --sur-bg:#F5F4FC;
  --card-bg:#ffffff;
  --soft-bg:#f7f5f0;
  --warn-bg:#fff8ec;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:'League Spartan',-apple-system,Segoe UI,Arial,sans-serif;
  background:var(--sur-bg);
  color:var(--navy);
  font-weight:400;
  -webkit-font-smoothing:antialiased;
  line-height:1.6;
}

/* Print bar (sticky purple gradient header, hides on print) */
.print-bar{
  position:sticky;top:0;z-index:50;
  background:var(--grad);
  padding:14px 24px;
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  box-shadow:0 2px 12px rgba(27,20,100,.18);
}
.print-bar-brand{
  font-family:'League Spartan',Arial,sans-serif;
  color:#fff;font-weight:900;font-size:18px;letter-spacing:1px;line-height:1;
}
.print-bar-brand .x{color:var(--blue)}
.print-bar-sub{
  font-size:9.5px;letter-spacing:2.5px;color:rgba(255,255,255,.75);
  text-transform:uppercase;font-weight:500;margin-top:3px;
}
.print-btn{
  background:#fff;color:var(--navy);
  font-family:'League Spartan',Arial,sans-serif;
  font-weight:900;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;
  border:none;border-radius:8px;padding:11px 20px;cursor:pointer;
  transition:transform .15s ease, box-shadow .15s ease;
}
.print-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.15)}

.wrap{max-width:880px;margin:0 auto;padding:0}

/* Cover (purple gradient header card) */
.rpt-cover{
  background:var(--grad);
  color:#fff;
  padding:36px 40px 32px;
  margin:24px 24px 0;
  border-radius:14px 14px 0 0;
  position:relative;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.cover-grid{
  display:grid;grid-template-columns:1fr auto;gap:32px;align-items:center;
}
.cover-left{min-width:0}
.cover-logo{
  font-family:'League Spartan',Arial,sans-serif;
  font-weight:900;font-size:22px;letter-spacing:1px;color:#fff;line-height:1;
}
.cover-logo .x{color:var(--blue)}
.cover-tag{
  font-size:10px;letter-spacing:2.5px;color:rgba(255,255,255,.75);
  text-transform:uppercase;font-weight:500;margin-top:5px;
}
.cover-sub{
  font-size:10px;letter-spacing:3px;color:rgba(255,255,255,.7);
  text-transform:uppercase;font-weight:700;margin-top:26px;
}
.cover-title{
  font-size:30px;font-weight:900;line-height:1.18;margin-top:6px;color:#fff;
  letter-spacing:-0.3px;
}
.cover-meta{
  font-size:12px;color:rgba(255,255,255,.85);margin-top:12px;letter-spacing:.5px;
}
.cover-meta strong{color:var(--blue);font-weight:700}

/* Gradient divider line */
.grad-line{
  height:4px;
  background:var(--grad-h);
  margin:0 24px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}

/* Body card */
.body-card{
  background:var(--card-bg);
  margin:0 24px 24px;
  padding:32px 40px 40px;
  border-radius:0 0 14px 14px;
  box-shadow:0 4px 24px rgba(27,20,100,.06);
}

/* Section headers (match survey .rpt-h) */
.rpt-h{
  font-family:'League Spartan',Arial,sans-serif;
  font-size:14px;font-weight:900;
  text-transform:uppercase;letter-spacing:2px;
  color:var(--navy);
  margin:36px 0 16px;
  padding-bottom:10px;
  border-bottom:2px solid var(--navy2);
}
.rpt-h:first-child{margin-top:0}

/* Executive summary */
.exec-box{
  background:var(--soft-bg);
  border-left:3px solid ${scoreColor};
  padding:18px 22px;
  font-size:14px;line-height:1.75;color:#333;
  border-radius:0 6px 6px 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}

.body-p{font-size:14px;line-height:1.7;color:#333;margin:10px 0}

/* Pillar score rows */
.sc-row{
  display:flex;align-items:center;gap:14px;margin:10px 0;
}
.sc-label{
  width:200px;flex-shrink:0;
  font-size:13px;font-weight:700;color:var(--navy);
  letter-spacing:.3px;
}
.sc-bar{
  flex:1;height:10px;background:#ede9e2;border-radius:5px;overflow:hidden;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.sc-fill{
  height:100%;border-radius:5px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.sc-num{
  width:42px;text-align:right;font-weight:900;font-size:18px;
  font-family:'League Spartan',Arial,sans-serif;
}

/* Two-column strengths/risks */
.col-2{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:8px}
@media (max-width:680px){.col-2{grid-template-columns:1fr;gap:8px}}
.col-h{
  font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:2px;
  margin:0 0 10px;
}
.col-h.pos{color:var(--green)}
.col-h.neg{color:var(--red)}
ul.bullet-list{padding-left:18px;margin:0;font-size:13.5px;line-height:1.7;color:#333}
ul.bullet-list li{margin:4px 0}

/* Theme rows */
.theme-row{margin:12px 0;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.theme-label{
  font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:2px;
  color:var(--navy);min-width:70px;padding-top:5px;
}
.theme-chips{flex:1}

/* Tag pills */
.tag{
  display:inline-block;font-size:11px;font-weight:700;
  padding:5px 11px;border-radius:12px;margin:3px 5px 3px 0;
  letter-spacing:.3px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.tag-pos{background:#E6F8EE;color:#005C2E}
.tag-neg{background:#FDECEA;color:#8B0000}
.tag-neu{background:#FEF3E2;color:#7A4500}

/* Verbatim quotes */
.qblock{
  background:#fafaf8;
  padding:14px 18px;
  margin:12px 0;
  border-radius:0 6px 6px 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.qblock-pos{border-left:3px solid var(--green)}
.qblock-neg{border-left:3px solid var(--red)}
.qblock-neu{border-left:3px solid var(--amber)}
.qtext{font-style:italic;font-size:14px;line-height:1.65;color:#222}
.qmeta{
  font-size:11px;color:#888;margin-top:8px;
  text-transform:uppercase;letter-spacing:1px;font-weight:600;
}
.qstars{color:#F7941D;margin-left:6px;letter-spacing:1px;font-size:12px}

/* Competitor grid */
.comp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:8px}
@media (max-width:680px){.comp-grid{grid-template-columns:1fr}}
.comp-card{
  background:var(--soft-bg);
  border-top:3px solid var(--amber);
  padding:16px 18px;
  border-radius:0 0 6px 6px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.comp-me{border-top-color:var(--blue)}
.comp-name{font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px}
.comp-score{
  font-family:'League Spartan',Arial,sans-serif;
  font-size:28px;font-weight:900;color:var(--navy);
  line-height:1;margin:6px 0 8px;
}
.comp-score-out{font-size:13px;color:#999;font-weight:500;margin-left:2px}
.comp-note{font-size:12px;color:#555;line-height:1.55}

/* Online presence */
.pres-row{display:flex;align-items:center;gap:14px;margin:8px 0}
.pres-name{
  width:160px;flex-shrink:0;
  font-size:13px;font-weight:700;color:var(--navy);
}
.pres-bar{
  flex:1;height:8px;background:#ede9e2;border-radius:4px;overflow:hidden;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pres-fill{
  height:100%;border-radius:4px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pres-num{
  width:36px;text-align:right;font-weight:900;font-size:15px;
  font-family:'League Spartan',Arial,sans-serif;
}
.pres-overall{
  font-size:12px;color:#666;font-weight:600;margin-left:10px;
  letter-spacing:1px;text-transform:uppercase;
}

/* Owner gap callout */
.gap-block{
  background:var(--warn-bg);
  border:1px solid #f5d78a;
  padding:14px 18px;
  margin-top:14px;
  border-radius:6px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.gap-label{
  font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:2px;
  color:var(--amber);margin-bottom:6px;
}
.gap-text{font-size:13.5px;line-height:1.65;color:#333}

/* Actions */
.act{
  display:flex;gap:16px;align-items:flex-start;
  background:var(--soft-bg);
  border-left:3px solid var(--gold);
  padding:16px 20px;
  margin:10px 0;
  border-radius:0 6px 6px 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.act-num{
  font-family:'League Spartan',Arial,sans-serif;
  font-weight:900;font-size:28px;color:var(--gold);
  line-height:1;min-width:38px;
}
.act-body{flex:1;min-width:0}
.act-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.act-title{font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px}
.act-pri{
  font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;
  padding:3px 9px;border-radius:10px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pri-hi{background:#FDECEA;color:#8B0000}
.pri-med{background:#FEF3E2;color:#7A4500}
.pri-lo{background:#E6F8EE;color:#005C2E}
.act-desc{font-size:13.5px;line-height:1.65;color:#444}

/* Footer */
.rpt-footer{
  text-align:center;font-size:11px;color:#888;padding:24px;
  letter-spacing:1px;
}
.rpt-footer-brand{
  font-weight:900;color:var(--navy);letter-spacing:1.5px;text-transform:uppercase;font-size:10px;
}
.rpt-footer-sub{margin-top:4px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#999}
.rpt-footer-priv{margin-top:10px;color:#aaa;letter-spacing:.5px;text-transform:none}

/* Responsive cover */
@media (max-width:680px){
  .cover-grid{grid-template-columns:1fr;gap:20px}
  .rpt-cover{padding:28px 24px 24px}
  .body-card{padding:24px 22px 32px}
  .cover-title{font-size:24px}
  .sc-label{width:140px;font-size:12px}
  .pres-name{width:110px;font-size:12px}
}

/* PRINT — clean PDF output */
@media print{
  body{background:#fff !important}
  .print-bar{display:none !important}
  .wrap{max-width:none}
  .rpt-cover,.body-card{margin:0;border-radius:0;box-shadow:none}
  .rpt-cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .grad-line{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .exec-box,.gap-block,.qblock,.comp-card,.act,.tag,.act-pri,
  .sc-bar,.sc-fill,.pres-bar,.pres-fill{
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
  }
  @page{margin:0.6in}
  .rpt-h{page-break-after:avoid}
  .act,.comp-card,.qblock{page-break-inside:avoid}
  .col-2{page-break-inside:avoid}
}
</style></head><body>

<!-- Sticky print bar (hidden on print) -->
<div class="print-bar">
  <div>
    <div class="print-bar-brand">diagnosti<span class="x">X</span></div>
    <div class="print-bar-sub">Restaurant HealthCheck · by 4xi</div>
  </div>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
</div>

<div class="wrap">

  <!-- Purple gradient cover -->
  <div class="rpt-cover">
    <div class="cover-grid">
      <div class="cover-left">
        <div class="cover-logo">diagnosti<span class="x">X</span></div>
        <div class="cover-tag">Restaurant HealthCheck · by 4xi</div>
        <div class="cover-sub">${esc(reportLabel)}</div>
        <div class="cover-title">${esc(restaurant)}</div>
        ${metaRow ? '<div class="cover-meta">' + metaRow + '</div>' : ''}
      </div>
      <div>${gaugeSvg}<div style="text-align:center;font-size:10px;letter-spacing:2.5px;color:rgba(255,255,255,.85);text-transform:uppercase;font-weight:700;margin-top:8px">${esc(verdict)}</div></div>
    </div>
  </div>

  <div class="grad-line"></div>

  <!-- White body card -->
  <div class="body-card">

    ${summary ? `
      <h2 class="rpt-h">Executive Summary</h2>
      <div class="exec-box">${esc(summary)}</div>
    ` : ''}

    ${pillarRows ? `
      <h2 class="rpt-h">Pillar Scores</h2>
      ${pillarRows}
    ` : ''}

    ${businessRealityBlock}

    ${(strengths || risks) ? `
      <h2 class="rpt-h">Strengths &amp; Risks</h2>
      <div class="col-2">
        <div>
          <div class="col-h pos">Strengths</div>
          <ul class="bullet-list">${strengths || '<li style="color:#999">None identified.</li>'}</ul>
        </div>
        <div>
          <div class="col-h neg">Risks</div>
          <ul class="bullet-list">${risks || '<li style="color:#999">None identified.</li>'}</ul>
        </div>
      </div>
    ` : ''}

    ${themesHtml ? `
      <h2 class="rpt-h">Themes</h2>
      ${themesHtml}
    ` : ''}

    ${verbatims ? `
      <h2 class="rpt-h">What Customers Are Saying</h2>
      ${verbatims}
    ` : ''}

    ${report?.employeeSentiment ? `
      <h2 class="rpt-h">Employee Sentiment</h2>
      <p class="body-p">${esc(report.employeeSentiment)}</p>
    ` : ''}

    ${competitors ? `
      <h2 class="rpt-h">Competitive Landscape</h2>
      ${report?.competitiveInsight ? '<p class="body-p" style="margin-bottom:14px">' + esc(report.competitiveInsight) + '</p>' : ''}
      <div class="comp-grid">${competitors}</div>
    ` : ''}

    ${onlineChannels ? `
      <h2 class="rpt-h">Online Presence ${onlineOverall != null ? '<span class="pres-overall">· Overall ' + onlineOverall + '/100</span>' : ''}</h2>
      ${onlineChannels}
    ` : ''}

    ${ownerBlock}

    ${commercialActionsBlock}

    ${actionsHtml ? `
      <h2 class="rpt-h">Recommended Actions</h2>
      ${actionsHtml}
    ` : ''}

  </div>

  <div class="rpt-footer">
    <div class="rpt-footer-brand">DiagnostiX by 4xi</div>
    <div class="rpt-footer-sub">24/7 · 365 Intelligence Platform</div>
    <div class="rpt-footer-priv">This link is private to ${esc(subscriber.email)}</div>
  </div>

</div></body></html>`;
}

// ── CREATE CUSTOMER (Annual or one-off) ──────────────────────
async function createCustomer({ email, firstName, restaurantName, location, website, report, survey, planType, amountPaid }) {
  const reportToken = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const isAnnual = planType === 'annual';

  // Extract optional business performance metrics from survey.
  // Each is either a number in the expected range, or null when operator skipped/didn't track.
  // Logged distinctly so we can measure fill rate from Railway logs while we evaluate
  // whether to build the richer report analysis.
  const bm = (survey && survey.businessMetrics) || {};
  const guestCountChange    = (typeof bm.guestCountChange    === 'number') ? bm.guestCountChange    : null;
  const avgCheckChange      = (typeof bm.avgCheckChange      === 'number') ? bm.avgCheckChange      : null;
  const profitabilityChange = (typeof bm.profitabilityChange === 'number') ? bm.profitabilityChange : null;
  const hasGuest  = guestCountChange    !== null;
  const hasCheck  = avgCheckChange      !== null;
  const hasProfit = profitabilityChange !== null;
  if (hasGuest || hasCheck || hasProfit) {
    console.log('[business-metrics] provided | guest:',  hasGuest  ? guestCountChange    + '%' : 'skipped',
                '| check:',  hasCheck  ? avgCheckChange      + '%' : 'skipped',
                '| profit:', hasProfit ? profitabilityChange + '%' : 'skipped',
                '| email:', email);
  } else {
    console.log('[business-metrics] skipped (all) | email:', email);
  }

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
    nextReportAt: isAnnual ? now + (4 * 30 * 24 * 60 * 60 * 1000) : null,
    guestCountChange,
    avgCheckChange,
    profitabilityChange
  };

  if (isAnnual) {
    annualSubscribers.set(reportToken, subscriber);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) {
    try {
      await fetch(url + '/rest/v1/subscribers?on_conflict=report_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          first_name:         firstName || null,
          restaurant_name:    restaurantName || null,
          location:           location || null,
          website:            website || null,
          subscribed_at:      new Date(now).toISOString(),
          next_report_at:     isAnnual ? new Date(subscriber.nextReportAt).toISOString() : null,
          reports_sent:       1,
          active:             isAnnual,
          plan_type:          planType,
          amount_paid:        amountPaid || 0,
          baseline_score:     report?.healthCheckScore || 0,
          baseline_report:    report || null,
          report_token:         reportToken,
          guest_count_change:   guestCountChange,
          avg_check_change:     avgCheckChange,
          profitability_change: profitabilityChange
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

  // 1. Exact email match
  let saved = reportStore.get(email);
  let matchType = 'exact';

  // 2. Local-part match (e.g. simon@a.com vs simon@b.com)
  if (!saved) {
    for (const [k, v] of reportStore.entries()) {
      if (k.includes(email.split('@')[0]) || email.includes(k.split('@')[0])) {
        saved = v;
        matchType = 'local-part';
        console.log('[webhook] Found report via local-part match:', k, '->', email);
        break;
      }
    }
  }

  // 3. Time-window fallback: most recent report saved within last 5 minutes.
  // Covers the common case where the user fills the survey with one email
  // (e.g. restaurant email) but checks out via Wix using a different email
  // (e.g. logged-in member account email).
  if (!saved) {
    const FIVE_MIN = 5 * 60 * 1000;
    const now = Date.now();
    let mostRecent = null;
    let mostRecentKey = null;
    for (const [k, v] of reportStore.entries()) {
      if (!v.savedAt) continue;
      const age = now - v.savedAt;
      if (age > FIVE_MIN) continue;
      if (!mostRecent || v.savedAt > mostRecent.savedAt) {
        mostRecent = v;
        mostRecentKey = k;
      }
    }
    if (mostRecent) {
      saved = mostRecent;
      matchType = 'time-window';
      const ageSec = Math.round((now - mostRecent.savedAt) / 1000);
      console.log('[webhook] Found report via time-window fallback:', mostRecentKey, '->', email, '| age:', ageSec + 's');
    }
  }

  if (!saved) {
    console.log('[webhook] No saved report for:', email, '| Store has:', reportStore.size, 'entries');
    await markPurchasedAndEmail(email, firstName || '', payload.restaurantName || '', {}, product);
    return;
  }

  console.log('[webhook] Match type:', matchType);

  const report     = saved.report || {};
  const survey     = saved.survey || {};
  const resolvedFirstName = firstName || survey.contactName || survey.firstName || '';
  const restaurant = survey.name || body.restaurantName || '';
  const location   = survey.location || '';

  // If we matched via time-window fallback, the Wix-supplied email is likely
  // a logged-in member account that differs from the survey email. The survey
  // email is the customer's real contact for this restaurant — send there.
  let destEmail = email;
  if (matchType === 'time-window' && survey.email && survey.email.toLowerCase() !== email) {
    console.log('[webhook] Time-window fallback: overriding webhook email', email, '-> survey email', survey.email);
    destEmail = survey.email.toLowerCase().trim();
  }

  console.log('[webhook] Payment confirmed for:', destEmail, product, '| Restaurant:', restaurant);

  // Legacy HubSpot purchase marker (kept for backward compatibility).
  await markPurchasedAndEmail(destEmail, resolvedFirstName, restaurant, report, product);

  if (!report || Object.keys(report).length === 0) {
    console.log('[webhook] No report data — skipping full customer creation');
    return;
  }

  // Unified flow: both Annual and one-off go through createCustomer.
  const planType = product === 'annual' ? 'annual' : 'one_off';
  const amountPaid = planType === 'annual' ? 99.99 : Number(payload.amountPaid || payload.amount || 24.99);

  const subscriber = await createCustomer({
    email: destEmail,
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
    sendCustomerReportEmail({ subscriber: supaShaped, report, reportNumber: 1, survey }),
    pushReportContextToHubSpot({ subscriber: supaShaped, report, reportNumber: 1, reportUrl, baseline: report })
  ]);

  console.log('[webhook] Full flow complete for', destEmail, '| plan:', planType);
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
    await fetch(`${url}/rest/v1/subscribers?report_token=eq.${encodeURIComponent(sub.reportToken)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body)
    });
    console.log('[supabase] Subscriber updated:', sub.email, '| token:', sub.reportToken, 'report', reportNumber);
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
        if (!row.report_token) return; // skip rows without token (legacy/test data)
        annualSubscribers.set(row.report_token, {
          email:          row.email,
          firstName:      row.first_name || '',
          restaurantName: row.restaurant_name || '',
          location:       row.location || '',
          website:        row.website || '',
          reportToken:    row.report_token,
          subscribedAt:   new Date(row.subscribed_at).getTime(),
          nextReportAt:   row.next_report_at ? new Date(row.next_report_at).getTime() : null,
          reports:        [{ generatedAt: new Date(row.subscribed_at).getTime(), report: row.baseline_report || { healthCheckScore: row.baseline_score || 0, pillars: {} }, reportNumber: 1 }]
        });
      });
      console.log('[annual] Loaded', annualSubscribers.size, 'active subscribers from Supabase');
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
  for (const [token, sub] of annualSubscribers.entries()) {
    if (sub.nextReportAt && now >= sub.nextReportAt) {
      console.log('[scheduler] Report due for:', sub.email, '|', sub.restaurantName, '| token:', token);
      await generateProgressReport(sub);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}, 6 * 60 * 60 * 1000);

// ── MANUAL TRIGGER (for testing) ─────────────────────────────
// Accepts either { email } (fires for ALL matching subscriptions) or { token } (specific subscription)
app.post('/trigger-annual-report', async (req, res) => {
  const { email, token, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  let targets = [];
  if (token) {
    const sub = annualSubscribers.get(token);
    if (sub) targets.push(sub);
  } else if (email) {
    const emailLower = email.toLowerCase();
    for (const sub of annualSubscribers.values()) {
      if (sub.email && sub.email.toLowerCase() === emailLower) targets.push(sub);
    }
  }

  if (targets.length === 0) return res.status(404).json({ error: 'No matching annual subscription found' });

  res.status(200).json({ ok: true, message: `Report generation started for ${targets.length} subscription(s)` });
  for (const sub of targets) {
    await generateProgressReport(sub);
    await new Promise(r => setTimeout(r, 3000));
  }
});

app.listen(PORT, () => console.log(`DiagnostiX v8.3 on port ${PORT}`));
