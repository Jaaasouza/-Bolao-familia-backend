const { normalizePhone } = require('../src/services/phone');

describe('normalizePhone — USA', () => {
  test('keeps a 10-digit US number canonical at 10 digits', () => {
    expect(normalizePhone('(415) 555-1234')).toEqual({
      country: 'US', digits: '4155551234', pretty: '(415) 555-1234',
    });
  });

  test('strips a leading US country code', () => {
    expect(normalizePhone('1-415-555-1234')).toMatchObject({ country: 'US', digits: '4155551234' });
  });
});

describe('normalizePhone — Brasil', () => {
  test('canonicalizes an 11-digit mobile sent with the 55 country code', () => {
    expect(normalizePhone('5511912345678')).toEqual({
      country: 'BR', digits: '5511912345678', pretty: '(11) 91234-5678',
    });
  });

  test('accepts a 10-digit landline with the 55 country code', () => {
    expect(normalizePhone('551131234567')).toEqual({
      country: 'BR', digits: '551131234567', pretty: '(11) 3123-4567',
    });
  });

  test('treats a bare 11-digit number as a Brazilian mobile (adds 55)', () => {
    expect(normalizePhone('21998765432')).toMatchObject({ country: 'BR', digits: '5521998765432' });
  });

  test('tolerates formatting characters', () => {
    expect(normalizePhone('+55 (11) 91234-5678').digits).toBe('5511912345678');
  });
});

describe('normalizePhone — rejects', () => {
  test.each(['', '123', null, undefined, 'abc', '123456789'])('returns null for %p', (v) => {
    expect(normalizePhone(v)).toBeNull();
  });
});
