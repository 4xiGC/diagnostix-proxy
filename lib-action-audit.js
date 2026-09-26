// ════════════════════════════════════════════════════════════════════════════
// WHAT AN ACTION NEEDS (2026-10-01, recommendation 9, A3).
//
// A recommendation a restaurant can act on names four things:
//   OWNER      who does it        an owner field, or a role named in the text
//   HORIZON    by when            a horizon field, the 30-day priority, or a time
//                                 bound in the text ("within 2 weeks", "by March")
//   INDICATOR  how you will know  an indicator field, or a measurable target in
//                                 the text ("to 4.5", "15 percent", "track ...")
//   REASON     why, from THIS     a finding field, a commercial `evidence` line, or
//              report             the text citing what reviews or the data showed
//
// The rule is deliberately literal: it reads the fields and the words, and it
// never guesses. "urgent" and "ongoing" are priorities, not horizons: neither
// says by when. The same function measures the stored reports (the baseline)
// and the new shape (B1), so the two numbers are comparable. Pure; never throws.
// ════════════════════════════════════════════════════════════════════════════

const ROLE = /\b(owner|owners|general manager|gm|head chef|executive chef|sous chef|chef|kitchen (?:lead|manager|team)|front[- ]of[- ]house(?: manager| lead| team)?|foh|floor manager|restaurant manager|operations manager|manager|sommelier|bar manager|marketing (?:lead|manager|team)|social media (?:lead|manager)|events? (?:lead|manager)|host(?:ess)? team|service team|finance|accountant|hr)\b/i;
const TIME = /\b(within \d+ (?:day|week|month)s?|in (?:the )?(?:next )?\d+ (?:day|week|month)s?|by (?:the end of )?(?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|next (?:week|month|quarter)|month[- ]end|year[- ]end)|this (?:week|month|quarter)|next (?:week|month|quarter)|\d+[- ](?:day|week|month)s?\b|90[- ]day|30[- ]day|60[- ]day)\b/i;
const MEASURE = /(\b(?:track|measure|monitor|target|kpi|metric|benchmark)\w*\b|\bto (?:at least )?\d+(?:\.\d+)?\b|\d+(?:\.\d+)?\s?(?:%|percent|points?|stars?|reviews? (?:per|a) (?:week|month))|\b(?:rating|score|covers|average check|repeat (?:visits|rate)|conversion|occupancy) (?:of|to|above|over|from) \d)/i;
const CITES = /\b(reviews?|reviewers|guests?|customers?|diners|feedback|tripadvisor|google|yelp|survey|your (?:numbers|data|metrics))\b[^.]{0,80}\b(cite|cites|mention|mentions|mentioned|complain|complaints|praise|praised|say|says|said|note|notes|noted|flag|flags|flagged|report|reported|show|shows|showed|describe|describes|call|calls)\b|["“][^"”]{6,}["”]/i;

function str(v) { return typeof v === 'string' ? v : ''; }

export function auditAction(item) {
  const a = (item && typeof item === 'object') ? item : {};
  const text = [str(a.title), str(a.desc), str(a.description), str(a.detail)].join(' ');
  const owner = !!str(a.owner).trim() || ROLE.test(text);
  const horizon = !!str(a.horizon).trim() || a.priority === '30days' || TIME.test(text);
  const indicator = !!str(a.indicator).trim() || MEASURE.test(text);
  const reason = !!str(a.finding).trim() || !!str(a.evidence).trim() || CITES.test(text);
  return { owner, horizon, indicator, reason, all4: owner && horizon && indicator && reason };
}

// Every action a stored or new report carries: the operational `actions`, the
// `commercialActions`, and (the B1 shape) `plan`. Each audited, with its source.
export function auditReportActions(report) {
  const r = (report && typeof report === 'object') ? report : {};
  const out = [];
  for (const [key, list] of [['actions', r.actions], ['commercialActions', r.commercialActions], ['plan', r.plan]]) {
    (Array.isArray(list) ? list : []).forEach((item, i) => out.push({ source: key + '[' + i + ']', title: str(item && item.title), ...auditAction(item) }));
  }
  const n = out.length;
  const count = (k) => out.filter((x) => x[k]).length;
  return { items: out, total: n, owner: count('owner'), horizon: count('horizon'), indicator: count('indicator'), reason: count('reason'), all4: count('all4') };
}

export const _patterns = { ROLE, TIME, MEASURE, CITES };
