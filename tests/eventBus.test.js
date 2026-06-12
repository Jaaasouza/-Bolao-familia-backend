jest.mock('../src/db/pool');
const db = require('../src/db/pool');
const { emit } = require('../src/services/eventBus');

function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
}

describe('eventBus.emit', () => {
  test('runs mutator + audit insert inside BEGIN/COMMIT', async () => {
    const client = fakeClient();
    db.getClient.mockResolvedValue(client);
    const mutator = jest.fn().mockResolvedValue('done');

    const result = await emit(
      'test.event',
      { actor: 'admin', entity: 'thing', entityId: '1', data: { a: 1 } },
      mutator
    );

    expect(result).toBe('done');
    expect(mutator).toHaveBeenCalledWith(client);

    const queries = client.query.mock.calls.map((c) => c[0]);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
    expect(queries.some((q) => q.includes('audit_log'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('rolls back and releases on mutator error', async () => {
    const client = fakeClient();
    db.getClient.mockResolvedValue(client);

    await expect(
      emit('test.event', {}, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const queries = client.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
