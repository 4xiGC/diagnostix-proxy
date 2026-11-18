// ════════════════════════════════════════════════════════════════════════════
// THE PLACE SEARCH IS BIASED TO WHERE THE RESTAURANT IS (Simon, 2026-11-18).
//
// /resolve-place sent "name, location" as text with no location bias, and when
// the location was empty Google ranked by where the SERVER is: from a machine in
// Chile, "Olive Garden Italian Restaurant" came back as a Santiago restaurant.
// 45 of 214 stored surveys had no location, and the three free-text boxes (City,
// State, Country) are often filled by browser autofill: "Texas Roadhouse Orlando"
// with "Atacama, Chile".
//
// THE RULE:
//   - City and Country are required. A survey without them is asked for them;
//     no search is sent without a City.
//   - Geocode City, State and Country together. State is kept when Google's
//     answer IS the typed city: one of its locality names is the City as typed
//     (accents and case folded). Otherwise State is ignored and City and Country
//     alone place the circle.
//     8.11.73 asked instead whether the answer lay inside City and Country's own
//     area. That was backwards for a second city of the same name: "Portland,
//     USA" is Oregon, so Portland, Maine, the more specific and more likely
//     correct answer, was thrown away (Simon, 2026-11-18). Now Portland, Maine
//     keeps its State, and Orlando with an autofilled Santiago state still loses
//     it, because Google's answer for that is not a place called Orlando.
//   - The Find Place call is biased to a circle around that point, its radius
//     half the diagonal of the area Google returned, clamped to 3 to 50 km.
//   - Neither geocode finds the place: the requester is asked to check the City
//     and Country. A geocoding OUTAGE (not a "not found") falls back to the text
//     search without bias, logged, so an outage never blocks a confirmation.
// Pure apart from the injected geocoder.
// ════════════════════════════════════════════════════════════════════════════

export const MIN_RADIUS_M = 3000;
export const MAX_RADIUS_M = 50000;

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

// The three parts from the request: the separate fields when the page sent them, else
// the joined "City, State, Country" (a page loaded before this release sends only that).
export function locationParts(body) {
  const b = body || {};
  if (clean(b.city) || clean(b.country)) return { city: clean(b.city), state: clean(b.state), country: clean(b.country) };
  const parts = clean(b.location).split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return { city: parts[0] || '', state: '', country: '' };
  return { city: parts[0], state: parts.slice(1, -1).join(', '), country: parts[parts.length - 1] };
}

function metres(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function radiusFor(viewport) {
  if (!viewport || !viewport.northeast || !viewport.southwest) return MIN_RADIUS_M;
  const half = metres(viewport.northeast, viewport.southwest) / 2;
  return Math.round(Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, half)));
}

// Accents, case and punctuation folded, so "Concepción" is "concepcion" and "St. Louis" is "st louis".
export function foldPlaceName(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Is this geocode the typed city? One of its locality names (locality, postal town,
// sublocality, district) is the City as typed.
export function isTypedCity(result, city) {
  const want = foldPlaceName(city);
  return !!want && Array.isArray(result && result.localities) && result.localities.some((n) => foldPlaceName(n) === want);
}

// geocode(address) resolves to { status: 'ok', point:{lat,lng}, viewport, localities, country } | { status: 'not-found' } | { status: 'error' }.
export async function biasForLocation({ city, state, country }, geocode) {
  if (!city || !country) return { ok: false, reason: 'location-required' };
  // Both geocodes start at once, so a slow geocoder costs one wait, not two.
  const [cityOnly, full] = await Promise.all([
    geocode(city + ', ' + country),
    state ? geocode(city + ', ' + state + ', ' + country) : null,
  ]);
  let chosen = null, used = 'city-country', stateIgnored = false;
  if (state) {
    if (full.status === 'ok' && isTypedCity(full, city)) {
      chosen = full; used = 'city-state-country';
    } else {
      stateIgnored = true;
    }
    if (!chosen && full.status === 'error' && cityOnly.status === 'error') return { ok: false, reason: 'geocode-error' };
  }
  if (!chosen) {
    if (cityOnly.status === 'ok') chosen = cityOnly;
    else return { ok: false, reason: cityOnly.status === 'error' ? 'geocode-error' : 'location-not-found' };
  }
  return { ok: true, center: chosen.point, radiusM: radiusFor(chosen.viewport), used, stateIgnored };
}

const LOCALITY_TYPES = ['locality', 'postal_town', 'sublocality', 'sublocality_level_1', 'administrative_area_level_3', 'colloquial_area'];

// The Geocoding API answer, read into the shape above.
export function readGeocode(json) {
  const j = json || {};
  const r = Array.isArray(j.results) ? j.results[0] : null;
  const loc = r && r.geometry && r.geometry.location;
  if (j.status === 'OK' && loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    const comps = Array.isArray(r.address_components) ? r.address_components : [];
    const has = (c, types) => Array.isArray(c.types) && c.types.some((t) => types.includes(t));
    const localities = [];
    for (const c of comps) {
      if (has(c, LOCALITY_TYPES)) for (const n of [c.long_name, c.short_name]) if (typeof n === 'string' && n && !localities.includes(n)) localities.push(n);
    }
    const ctry = comps.find((c) => has(c, ['country']));
    return { status: 'ok', point: { lat: loc.lat, lng: loc.lng }, viewport: r.geometry.viewport || r.geometry.bounds || null,
      localities, country: ctry ? { long: ctry.long_name || null, short: ctry.short_name || null } : null };
  }
  if (j.status === 'ZERO_RESULTS' || (j.status === 'OK' && !r)) return { status: 'not-found' };
  return { status: 'error' };
}
