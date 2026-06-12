const { MIGRATIONS } = require('../src/db/migrations');

describe('migrations', () => {
  test('versions are unique, sequential from 1, and in order', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions[0]).toBe(1);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1);
    }
  });

  test('every migration has a name and an up() function', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.up).toBe('function');
    }
  });
});
