// ════════════════════════════════════════════════════════════════════════════
// lib-place-bias.js (Simon, 2026-11-18, fix 2): geocode City, State and Country;
// if that fails or lands outside City and Country's own area, use City and
// Country alone and ignore State.
//
// 2026-11-18, the follow-on: State is kept when Google's City, State and Country
// answer IS the typed city (its locality is the City as typed), not when it lies
// inside City and Country's area, which threw away Portland, Maine.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { locationParts, biasForLocation, readGeocode, isTypedCity, MIN_RADIUS_M, MAX_RADIUS_M } from '../lib-place-bias.js';

const at = (lat, lng, d, localities = []) => ({ status: 'ok', point: { lat, lng },
  viewport: { northeast: { lat: lat + d, lng: lng + d }, southwest: { lat: lat - d, lng: lng - d } }, localities });
const geo = (map) => async (address) => map[address] || { status: 'not-found' };

test('the parts: the separate fields, else the joined string; one part has no country', () => {
  assert.deepEqual(locationParts({ city: ' Orlando ', state: 'Florida', country: 'USA' }), { city: 'Orlando', state: 'Florida', country: 'USA' });
  assert.deepEqual(locationParts({ location: 'Vitacura, Santiago, Chile' }), { city: 'Vitacura', state: 'Santiago', country: 'Chile' });
  assert.deepEqual(locationParts({ location: 'London, UK' }), { city: 'London', state: '', country: 'UK' });
  assert.deepEqual(locationParts({ location: 'Santiago' }), { city: 'Santiago', state: '', country: '' });
  assert.deepEqual(locationParts({}), { city: '', state: '', country: '' });
});

test('the answer is the typed city: State is used', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Florida', country: 'USA' },
    geo({ 'Orlando, USA': at(28.5, -81.4, 0.2, ['Orlando']), 'Orlando, Florida, USA': at(28.54, -81.38, 0.1, ['Orlando']) }));
  assert.deepEqual([r.ok, r.used, r.stateIgnored, r.center.lat], [true, 'city-state-country', false, 28.54]);
});

test('AUTOFILL: Orlando with a Santiago state answers a place that is not Orlando, so State is ignored', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Region Metropolitana de Santiago', country: 'USA' },
    geo({ 'Orlando, USA': at(28.5, -81.4, 0.2, ['Orlando']),
      'Orlando, Region Metropolitana de Santiago, USA': at(-33.45, -70.66, 0.5, ['Santiago']) }));
  assert.deepEqual([r.used, r.stateIgnored, r.center.lat], ['city-country', true, 28.5]);
});

test('AUTOFILL, the answer is only a region (no locality): State is ignored', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Atacama', country: 'USA' },
    geo({ 'Orlando, USA': at(28.5, -81.4, 0.2, ['Orlando']), 'Orlando, Atacama, USA': at(-27.4, -70.3, 1, []) }));
  assert.deepEqual([r.used, r.stateIgnored, r.center.lat], ['city-country', true, 28.5]);
});

test('State that does not geocode is ignored', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Nowhere', country: 'USA' }, geo({ 'Orlando, USA': at(28.5, -81.4, 0.2) }));
  assert.deepEqual([r.used, r.stateIgnored], ['city-country', true]);
});

test('City and Country alone fail but with State it geocodes to that city: State is used', async () => {
  const r = await biasForLocation({ city: 'Hamlet', state: 'County', country: 'X' }, geo({ 'Hamlet, County, X': at(1, 1, 0.05, ['Hamlet']) }));
  assert.deepEqual([r.ok, r.used], [true, 'city-state-country']);
});

// The 8.11.73 rule threw this away ("Portland, USA" is Oregon, and Maine lies outside it).
test('A SECOND CITY OF THE SAME NAME keeps its State: Portland, Maine, not Oregon', async () => {
  const r = await biasForLocation({ city: 'Portland', state: 'Maine', country: 'USA' },
    geo({ 'Portland, USA': at(45.52, -122.68, 0.2, ['Portland']), 'Portland, Maine, USA': at(43.66, -70.26, 0.1, ['Portland']) }));
  assert.deepEqual([r.used, r.stateIgnored, r.center.lat], ['city-state-country', false, 43.66]);
});

test('the locality is compared folded, against every locality name Google gives', () => {
  assert.equal(isTypedCity({ localities: ['Concepción'] }, 'concepcion'), true);
  assert.equal(isTypedCity({ localities: ['Saint Louis', 'St. Louis'] }, 'St Louis'), true);
  assert.equal(isTypedCity({ localities: ['Vitacura', 'Santiago'] }, 'Vitacura'), true);
  assert.equal(isTypedCity({ localities: ['Orlando'] }, 'Orlandoo'), false);
  assert.equal(isTypedCity({ localities: [] }, 'Orlando'), false);
  assert.equal(isTypedCity({}, 'Orlando'), false);
});

test('nothing on the map asks; an outage is an error, not a not-found; no City asks', async () => {
  assert.equal((await biasForLocation({ city: 'X', country: 'Y' }, geo({}))).reason, 'location-not-found');
  assert.equal((await biasForLocation({ city: 'X', state: 'S', country: 'Y' }, geo({}))).reason, 'location-not-found');
  assert.equal((await biasForLocation({ city: 'X', country: 'Y' }, async () => ({ status: 'error' }))).reason, 'geocode-error');
  assert.equal((await biasForLocation({ city: 'X', state: 'S', country: 'Y' }, async () => ({ status: 'error' }))).reason, 'geocode-error');
  let calls = 0;
  assert.equal((await biasForLocation({ city: '', country: 'Y' }, async () => { calls++; return { status: 'error' }; })).reason, 'location-required');
  assert.equal(calls, 0);
});

test('both geocodes are in flight at once, so a slow geocoder costs one wait', async () => {
  let inFlight = 0, most = 0;
  const slow = async (address) => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return address === 'Orlando, USA' ? at(28.5, -81.4, 0.2, ['Orlando']) : at(28.54, -81.38, 0.1, ['Orlando']);
  };
  await biasForLocation({ city: 'Orlando', state: 'Florida', country: 'USA' }, slow);
  assert.equal(most, 2);
});

test('the radius is half the area diagonal, clamped to 3 to 50 km', async () => {
  const tiny = await biasForLocation({ city: 'A', country: 'B' }, geo({ 'A, B': at(10, 10, 0.001) }));
  const huge = await biasForLocation({ city: 'A', country: 'B' }, geo({ 'A, B': at(10, 10, 5) }));
  const mid = await biasForLocation({ city: 'A', country: 'B' }, geo({ 'A, B': at(0, 0, 0.1) }));
  assert.equal(tiny.radiusM, MIN_RADIUS_M);
  assert.equal(huge.radiusM, MAX_RADIUS_M);
  assert.ok(mid.radiusM > 15000 && mid.radiusM < 16500, String(mid.radiusM)); // 0.2 deg square: diagonal ~31.4 km
});

test('readGeocode reads the locality names and the country', () => {
  const g = readGeocode({ status: 'OK', results: [{ geometry: { location: { lat: 43.66, lng: -70.26 } }, address_components: [
    { long_name: 'Portland', short_name: 'Portland', types: ['locality', 'political'] },
    { long_name: 'Cumberland County', short_name: 'Cumberland County', types: ['administrative_area_level_2', 'political'] },
    { long_name: 'Maine', short_name: 'ME', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'United States', short_name: 'US', types: ['country', 'political'] }] }] });
  assert.deepEqual(g.localities, ['Portland']);
  assert.deepEqual(g.country, { long: 'United States', short: 'US' });
});

test('readGeocode: OK with a result, ZERO_RESULTS, OK with none, anything else is an error', () => {
  assert.equal(readGeocode({ status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 } } }] }).status, 'ok');
  assert.equal(readGeocode({ status: 'ZERO_RESULTS', results: [] }).status, 'not-found');
  assert.equal(readGeocode({ status: 'OK', results: [] }).status, 'not-found');
  assert.equal(readGeocode({ status: 'OVER_QUERY_LIMIT' }).status, 'error');
  assert.equal(readGeocode(null).status, 'error');
});
