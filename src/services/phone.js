// Phone normalization shared by the players + phone-auth routes.
//
// Supports two countries:
//   US — 10 national digits. Canonical `digits` stays 10 (a leading "1" country
//        code is stripped). A bare 10-digit string is treated as US.
//   BR — 10 (landline) or 11 (mobile) national digits. Canonical `digits` is the
//        calling code + national ("55" + national), so a Brazilian number can
//        never collide with a US one and the two are told apart by the "55"
//        prefix. The web client already sends BR numbers in this canonical form.
//
// Returns { country, digits, pretty } or null. `digits` is what we persist in
// players.phone_digits (the unique key); `pretty` is the human display string.

function prettyUs(d) {
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function prettyBr(n) {
  const ddd = n.slice(0, 2);
  const rest = n.slice(2);
  return rest.length === 9
    ? `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`
    : `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
}

function normalizePhone(input) {
  const d = String(input || '').replace(/\D/g, '');
  if (!d) return null;

  // Brazil with an explicit country code (12-13 digits) → national 10/11.
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const national = d.slice(2);
    return { country: 'BR', digits: `55${national}`, pretty: prettyBr(national) };
  }

  // US with a leading country code → strip to 10 national digits.
  if (d.length === 11 && d.startsWith('1')) {
    const national = d.slice(1);
    return { country: 'US', digits: national, pretty: prettyUs(national) };
  }

  // Bare 10-digit number → US.
  if (d.length === 10) {
    return { country: 'US', digits: d, pretty: prettyUs(d) };
  }

  // Bare 11-digit number (no country code) → Brazilian mobile typed without 55.
  if (d.length === 11) {
    return { country: 'BR', digits: `55${d}`, pretty: prettyBr(d) };
  }

  return null;
}

module.exports = { normalizePhone, prettyUs, prettyBr };
