// ════════════════════════════════════════════════════════════════════════════
// THE PRICE, AND WHAT amount_paid IS ALLOWED TO SAY (v8.11.45)
//
// Until this release every subscriber row was written with a HARD-CODED
// amount: one literal for a one-off, another for the retired annual plan.
// Three literals in three code paths, none of them read from anywhere.
//
// WIX CHARGES THE LIST PRICE BELOW. So every one of the 99 rows carrying the
// old one-off literal records a number that was never paid, and
// `select sum(amount_paid) from subscribers` has never been a true figure.
// Measured 2026-09-21: 99 rows at the one-off literal, 1 at the annual
// literal, 0 null, 0 zero. The exact figures are in PROGRAM_PROGRESS.md.
//
// THE SERVICE CANNOT READ WHAT WIX CHARGED. The webhook payload has never
// carried an amount: if it had, the 99 rows would not all be identical. So
// amount_paid is written as NULL. A null says "we did not observe this",
// which is true. A number says "this is what they paid", which was not.
//
// NULL IS NOT ZERO, and this file exists partly to keep those apart. A zero is
// a measurement: it says the customer paid nothing. Every reader here treats
// null as absent and never renders it as 0, $0.00 or NaN.
//
// RECONCILING THE 99 HISTORICAL ROWS from the Wix orders export is package
// item 6 and is NOT done here. Nothing in this file rewrites a stored row.
// ════════════════════════════════════════════════════════════════════════════

// The one place the list price is written down in server code. The survey page
// is a static file and carries its own literal in the paywall button; that is
// copy, and the ship gate checks the two agree.
export const LIST_PRICE_USD = 49.99;

// "$49.99". Used wherever the list price is shown, so a price change is one
// edit and not a search.
export function listPriceLabel() {
  return '$' + LIST_PRICE_USD.toFixed(2);
}

// What goes into subscribers.amount_paid on every insert path.
//
// ALWAYS NULL, deliberately. The column is nullable, confirmed from the
// PostgREST schema before this was written, so no migration is involved.
export function amountPaidToWrite() {
  return null;
}

// Is this a real observed amount, as opposed to absent?
//
// Rejects null, undefined, '', NaN, Infinity, booleans and negatives. Zero is
// REJECTED as well: no order in this product has ever been free, so a zero in
// this column is a coercion artefact, which is exactly how `|| 0` used to turn
// an absent amount into "they paid nothing".
export function isRealAmount(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// For anything that shows an amount to a person. Never 0, never $0.00, never
// NaN, never "null".
export const AMOUNT_ABSENT_LABEL = 'not recorded';

export function formatAmountPaid(v) {
  return isRealAmount(v) ? '$' + Number(v).toFixed(2) : AMOUNT_ABSENT_LABEL;
}

// The HubSpot contact properties for an amount. An absent amount sends NO
// PROPERTY AT ALL rather than a zero.
//
// This used to be `subField('amount_paid', 'amountPaid') || 0`, so the moment
// amount_paid became null every contact would have been stamped with an amount
// paid of 0 US dollars. That is a worse claim than the wrong literal it
// replaces: zero reads as "this customer paid nothing".
export function hubspotAmountFields(subscriber) {
  const s = (subscriber && typeof subscriber === 'object') ? subscriber : {};
  const raw = s.amount_paid !== undefined ? s.amount_paid : s.amountPaid;
  return isRealAmount(raw) ? { diagnostix_amount_paid_usd: Number(raw) } : {};
}
