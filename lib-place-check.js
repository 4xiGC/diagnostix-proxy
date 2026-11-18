// ════════════════════════════════════════════════════════════════════════════
// THE CONFIRMATION SCREEN SAYS WHEN GOOGLE'S LISTING DOES NOT LOOK LIKE WHAT
// WAS TYPED (Simon, 2026-11-18, fix 3).
//
// The requester confirms the Google listing before anything is spent, but a
// listing with another name, or in another country, looked the same as a
// match: the place audit found reports assessed on a listing whose name shared
// no word with the typed one. Two checks, two notices, since they catch
// different things. Each is shown above the card, as approved:
//
//   NAME     no significant word of the typed name appears in Google's name
//            (accents, case and filler words such as "restaurant" ignored).
//   COUNTRY  the country Google gives for the survey's City and Country is
//            not the country at the end of the listing's address. Only when
//            both are known: a failed geocode shows no country notice.
//
// A notice informs; it never blocks. Yes still assesses exactly the listing shown.
// Pure.
// ════════════════════════════════════════════════════════════════════════════

export const NOTICE_COUNTRY = "Google's listing is in a different country from the one in your survey. Check the address below before you continue.";
export function noticeName(typed) {
  return "Google's listing has a different name from what you typed (" + typed + '). Check the address below before you continue.';
}

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’'`]/g, '');

// The words that carry no identity. Taken from the 2026-11-18 place audit, which flagged on them.
const STOP = new Set(('the and restaurant restaurante resto bar cafe grill kitchen house club inn pub location address '
  + 'analyse analyze to of at in on de del la el le les los las y en city fl ca ny usa uk united states kingdom chile '
  + 'drive dr road rd street st avenue ave local suite ste near').split(' '));
export function significantWords(s) {
  return fold(s).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

// true: no significant typed word is in Google's name. null: nothing to compare (no
// significant typed word, or no Google name), so no notice.
export function nameDiffers(typed, googleName) {
  const a = significantWords(typed);
  const joined = fold(googleName).replace(/[^\p{L}\p{N}]+/gu, '');
  if (!a.length || !joined) return null;
  const b = new Set(significantWords(googleName));
  return !a.some((w) => b.has(w) || joined.includes(w));
}

// Google writes the United States as "USA" and the United Kingdom as "UK" at the end of an address.
const ADDRESS_FORMS = { US: ['usa', 'united states', 'us'], GB: ['uk', 'united kingdom', 'gb'] };

// geoCountry: { long, short } from the geocode of the survey's City and Country.
// true: the listing's address ends in another country. null: either side unknown.
export function countryDiffers(geoCountry, formattedAddress) {
  if (!geoCountry || (!geoCountry.long && !geoCountry.short)) return null;
  const parts = String(formattedAddress || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = fold(parts[parts.length - 1]).replace(/[0-9]+/g, ' ').replace(/[^\p{L} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!last) return null;
  const forms = new Set([fold(geoCountry.long), fold(geoCountry.short)].filter(Boolean));
  for (const f of ADDRESS_FORMS[String(geoCountry.short || '').toUpperCase()] || []) forms.add(f);
  return !forms.has(last);
}

export function placeNotices({ typedName, googleName, formattedAddress, geoCountry }) {
  const out = [];
  if (nameDiffers(typedName, googleName) === true) out.push({ kind: 'name', text: noticeName(String(typedName).trim()) });
  if (countryDiffers(geoCountry, formattedAddress) === true) out.push({ kind: 'country', text: NOTICE_COUNTRY });
  return out;
}
