// BAND VOCABULARY COHERENCE ON A RENDERED PAGE.
//
// ── WHAT THIS GUARDS AGAINST, WHICH IS NOT WHAT IT FIRST LOOKS LIKE ───────
//
// The 18 stored peer fragments carry the OLD six-band vocabulary (Exceptional,
// Strong, Solid, Mixed, Weak, Critical, "band 5 of 6") while the product's
// bands are now four (Excellent 80, Good 65, Fair 45, Needs Attention 0).
// B5.1 rebuilds them.
//
// THIS IS NOT A CHECK THAT B5.1 HAS HAPPENED. A coherent six-band fragment is
// out of date but it is not WRONG about itself: its labels and its counts were
// produced by the same boundaries and they agree.
//
// THE DANGEROUS STATE IS THE HALF-MIGRATION. Substitute the six words for the
// four in the stored markup and every label reads correctly while every count
// behind it was computed against boundaries that no longer exist. The page
// then says "Good (band 3 of 4), 4 peers above" when all four peers are in
// that same band. Nothing on the page looks broken. That is the failure this
// gate exists for, and it is a plausible shortcut precisely because it is
// cheap.
//
// MEASURED, on General Tarleton Inn, Pricing and Accessibility, 2026-09-23:
//
//     six bands   Solid 4 of 6    4 above / 0 same / 0 below
//     four bands  Good  3 of 4    0 above / 4 same / 0 below
//
// Same peers, same scores, opposite message. The counts are NOT recoverable
// from the markup, so a page that mixes the two is unfixable in place and has
// to be rebuilt from the stored benchmark rows.
//
// ── SCOPED TO BAND CELLS, AND THAT SCOPE IS LOAD-BEARING ──────────────────
//
// A whole RVP report contains the words "Excellent", "Good" and "Fair" from
// its OWN cover verdict, which is a four-band verdict and always has been.
// A naive "do both word families appear on this page" check would flag every
// report that carries a six-band peer fragment, on the strength of a word in
// an unrelated heading. So the unit of measurement is the BAND CELL:
//
//     <td>Strong <span class="muted">(band 5 of 6)</span></td>
//
// which carries the word and the denominator together, in one place, written
// by one renderer. Prose is not scanned and must not be.

// Disjoint by construction. If a word is ever added to both lists this file is
// wrong, and the test asserts the intersection is empty rather than trusting
// the author of the next edit to notice.
export const FOUR_BAND_WORDS = ['Excellent', 'Good', 'Fair', 'Needs Attention'];
export const SIX_BAND_WORDS = ['Exceptional', 'Strong', 'Solid', 'Mixed', 'Weak', 'Critical'];

export const FAMILY_SIZE = { four: 4, six: 6 };

export function familyOf(word) {
  const w = String(word || '').trim();
  if (FOUR_BAND_WORDS.includes(w)) return 'four';
  if (SIX_BAND_WORDS.includes(w)) return 'six';
  return null;
}

// Every band cell on the page, as written. The denominator is taken from the
// markup, never assumed from the word, because the whole point is to catch the
// case where they disagree.
export function scanBandCells(html) {
  const out = [];
  const re = /<td>([A-Za-z][A-Za-z ]*?)\s*<span class="muted">\(band\s*(\d+)\s*of\s*(\d+)\)<\/span><\/td>/g;
  for (const m of String(html || '').matchAll(re)) {
    out.push({
      word: m[1].trim(),
      index: Number(m[2]),
      of: Number(m[3]),
      family: familyOf(m[1]),
    });
  }
  return out;
}

// The findings for one page.
//
// `ok` is false when the page is INCOHERENT, which is three things:
//   mixedFamilies  cells from both vocabularies on one page
//   mismatched     a word from one family carrying the other's denominator
//   unknownWords   a band word belonging to neither list, which means a third
//                  vocabulary appeared and nothing here is checking it
//
// A page with NO band cells is `ok` with `cells: 0`. That is not a pass and
// the caller must not count it as one: it is a page this gate says nothing
// about. The corpus sweep reports that population separately.
export function vocabularyFindings(html) {
  const cells = scanBandCells(html);
  const families = [...new Set(cells.map((c) => c.family).filter(Boolean))];
  const unknownWords = [...new Set(cells.filter((c) => !c.family).map((c) => c.word))];
  const mismatched = cells.filter((c) => c.family && c.of !== FAMILY_SIZE[c.family]);
  // A cell can also claim an index outside its own denominator, for example
  // "band 5 of 4". That is not a vocabulary mix, it is arithmetic, and it is
  // caught here because nothing else looks at it.
  const outOfRange = cells.filter((c) => c.index < 1 || c.index > c.of);

  return {
    cells: cells.length,
    families,
    mixedFamilies: families.length > 1,
    mismatched: mismatched.map((c) => ({ word: c.word, index: c.index, of: c.of, expected: FAMILY_SIZE[c.family] })),
    unknownWords,
    outOfRange: outOfRange.map((c) => ({ word: c.word, index: c.index, of: c.of })),
    ok: families.length <= 1 && mismatched.length === 0
        && unknownWords.length === 0 && outOfRange.length === 0,
  };
}

// One line a human can act on, for the sweep's output.
export function describeFindings(f) {
  if (f.ok) return f.cells ? 'coherent, ' + (f.families[0] || 'no') + '-band, ' + f.cells + ' cells' : 'no band cells';
  const parts = [];
  if (f.mixedFamilies) parts.push('MIXED VOCABULARIES: ' + f.families.join(' and '));
  for (const m of f.mismatched) parts.push('"' + m.word + '" is a ' + FAMILY_SIZE[familyOf(m.word)] + '-band word carrying "of ' + m.of + '"');
  for (const w of f.unknownWords) parts.push('unknown band word "' + w + '"');
  for (const o of f.outOfRange) parts.push('band ' + o.index + ' of ' + o.of + ' is out of range');
  return parts.join('; ');
}
