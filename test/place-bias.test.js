// ════════════════════════════════════════════════════════════════════════════
// lib-place-bias.js (Simon, 2026-11-18, fix 2): geocode City, State and Country;
// if that fails or lands outside City and Country's own area, use City and
// Country alone and ignore State.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { locationParts, biasForLocation, readGeocode, MIN_RADIUS_M, MAX_RADIUS_M } from '../lib-place-bias.js';

const at = (lat, lng, d) => ({ status: 'ok', point: { lat, lng },
  viewport: { northeast: { lat: lat + d, lng: lng + d }, southwest: { lat: lat - d, lng: lng - d } } });
const geo = (map) => async (address) => map[address] || { status: 'not-found' };

test('the parts: the separate fields, else the joined string; one part has no country', () => {
  assert.deepEqual(locationParts({ city: ' Orlando ', state: 'Florida', country: 'USA' }), { city: 'Orlando', state: 'Florida', country: 'USA' });
  assert.deepEqual(locationParts({ location: 'Vitacura, Santiago, Chile' }), { city: 'Vitacura', state: 'Santiago', country: 'Chile' });
  assert.deepEqual(locationParts({ location: 'London, UK' }), { city: 'London', state: '', country: 'UK' });
  assert.deepEqual(locationParts({ location: 'Santiago' }), { city: 'Santiago', state: '', country: '' });
  assert.deepEqual(locationParts({}), { city: '', state: '', country: '' });
});

test('State inside the City area is used', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Florida', country: 'USA' },
    geo({ 'Orlando, USA': at(28.5, -81.4, 0.2), 'Orlando, Florida, USA': at(28.54, -81.38, 0.1) }));
  assert.deepEqual([r.ok, r.used, r.stateIgnored, r.center.lat], [true, 'city-state-country', false, 28.54]);
});

test('State outside the City area (autofill) is ignored', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Atacama', country: 'USA' },
    geo({ 'Orlando, USA': at(28.5, -81.4, 0.2), 'Orlando, Atacama, USA': at(-27.4, -70.3, 1) }));
  assert.deepEqual([r.used, r.stateIgnored, r.center.lat], ['city-country', true, 28.5]);
});

test('State that does not geocode is ignored', async () => {
  const r = await biasForLocation({ city: 'Orlando', state: 'Nowhere', country: 'USA' }, geo({ 'Orlando, USA': at(28.5, -81.4, 0.2) }));
  assert.deepEqual([r.used, r.stateIgnored], ['city-country', true]);
});

test('City and Country alone fail but with State it geocodes: State is used', async () => {
  const r = await biasForLocation({ city: 'Hamlet', state: 'County', country: 'X' }, geo({ 'Hamlet, County, X': at(1, 1, 0.05) }));
  assert.deepEqual([r.ok, r.used], [true, 'city-state-country']);
});

// AS RULED, and reported to Simon: "Portland, USA" geocodes to Oregon, so Portland, Maine lands
// outside it and State is ignored. The rule protects against autofill; it does not resolve this.
test('KNOWN CONSEQUENCE: a second city of the same name is outside the first one\'s area, so State is ignored', async () => {
  const r = await biasForLocation({ city: 'Portland', state: 'Maine', country: 'USA' },
    geo({ 'Portland, USA': at(45.52, -122.68, 0.2), 'Portland, Maine, USA': at(43.66, -70.26, 0.1) }));
  assert.deepEqual([r.used, r.stateIgnored, r.center.lat], ['city-country', true, 45.52]);
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
    return address === 'Orlando, USA' ? at(28.5, -81.4, 0.2) : at(28.54, -81.38, 0.1);
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

test('readGeocode: OK with a result, ZERO_RESULTS, OK with none, anything else is an error', () => {
  assert.equal(readGeocode({ status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 } } }] }).status, 'ok');
  assert.equal(readGeocode({ status: 'ZERO_RESULTS', results: [] }).status, 'not-found');
  assert.equal(readGeocode({ status: 'OK', results: [] }).status, 'not-found');
  assert.equal(readGeocode({ status: 'OVER_QUERY_LIMIT' }).status, 'error');
  assert.equal(readGeocode(null).status, 'error');
});
