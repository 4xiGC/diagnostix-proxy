// ════════════════════════════════════════════════════════════════════════════
// lib-place-check.js (Simon, 2026-11-18, fix 3): the two notices on the
// confirmation screen, in the approved wording, and when each fires.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeNotices, nameDiffers, countryDiffers, NOTICE_COUNTRY, noticeName } from '../lib-place-check.js';

const US = { long: 'United States', short: 'US' };
const GB = { long: 'United Kingdom', short: 'GB' };
const CL = { long: 'Chile', short: 'CL' };

test('THE APPROVED WORDING, both variants', () => {
  assert.equal(noticeName('Mailard'), "Google's listing has a different name from what you typed (Mailard). Check the address below before you continue.");
  assert.equal(NOTICE_COUNTRY, "Google's listing is in a different country from the one in your survey. Check the address below before you continue.");
});

test('NAME: fires when no significant typed word is in Google\'s name', () => {
  assert.equal(nameDiffers('Mailard', 'Maillard'), true);
  // The paid 2026-05-21 report (the place audit): typed "Mailard", Google's listing "Maillard - Cocina a las Brasas".
  assert.equal(nameDiffers('Mailard', 'Maillard - Cocina a las Brasas'), true);
  assert.equal(nameDiffers('West Coast Pretzels', 'Auntie Anne\'s'), true);
  assert.equal(nameDiffers('Olive Garden Italian Restaurant', 'Teclados'), true);
});

test('NAME: silent on a real match, accents, case, filler words and a joined name', () => {
  assert.equal(nameDiffers('Maillard', 'Maillard Bistro'), false);
  assert.equal(nameDiffers('olive garden', 'Olive Garden Italian Restaurant'), false);
  assert.equal(nameDiffers('Café Concepción', 'Concepcion Cafe'), false);
  assert.equal(nameDiffers('Texas Roadhouse 10811 International Dr', 'Texas Roadhouse'), false);
  assert.equal(nameDiffers('Bocanariz', 'Boca Nariz'), false, 'the joined Google name holds the typed word');
});

test('NAME: nothing significant to compare is no notice, not a mismatch', () => {
  assert.equal(nameDiffers('The Restaurant', 'Anything'), null);
  assert.equal(nameDiffers('Maillard', ''), null);
});

test('COUNTRY: fires when the address ends in another country', () => {
  assert.equal(countryDiffers(US, 'Av. Italia 1234, Santiago, Chile'), true);
  assert.equal(countryDiffers(CL, '10811 International Dr, Orlando, FL 32821, USA'), true);
});

test('COUNTRY: silent on Google\'s own address forms (USA, UK) and postcodes', () => {
  assert.equal(countryDiffers(US, '10811 International Dr, Orlando, FL 32821, USA'), false);
  assert.equal(countryDiffers(GB, '1 High St, London SW1A 1AA, UK'), false);
  assert.equal(countryDiffers(CL, 'Av. Italia 1234, Santiago, Chile'), false);
  assert.equal(countryDiffers({ long: 'Singapore', short: 'SG' }, '1 Raffles Pl, Singapore 048616'), false);
});

test('COUNTRY: either side unknown is no notice', () => {
  assert.equal(countryDiffers(null, 'Av. Italia 1234, Santiago, Chile'), null);
  assert.equal(countryDiffers(US, null), null);
  assert.equal(countryDiffers(US, 'Somewhere'), null);
});

test('BOTH can fire, name first; none on a clean match', () => {
  const both = placeNotices({ typedName: 'Olive Garden', googleName: 'Teclados', formattedAddress: 'Av. Italia 1234, Santiago, Chile', geoCountry: US });
  assert.deepEqual(both.map((n) => n.kind), ['name', 'country']);
  assert.equal(both[0].text, noticeName('Olive Garden'));
  assert.deepEqual(placeNotices({ typedName: 'Teclados', googleName: 'Teclados', formattedAddress: 'Av. Italia 1234, Santiago, Chile', geoCountry: CL }), []);
});
