import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeRequestHash } from '../audioJobs';

describe('audioJobs request hashing', () => {
  it('produces the same hash regardless of object key order', () => {
    const a = computeRequestHash({ text: 'Hello', voiceId: 'v1', nested: { b: 2, a: 1 } });
    const b = computeRequestHash({ nested: { a: 1, b: 2 }, voiceId: 'v1', text: 'Hello' });
    assert.equal(a, b);
  });

  it('produces different hashes for different payloads', () => {
    const a = computeRequestHash({ text: 'Hello' });
    const b = computeRequestHash({ text: 'Hello!' });
    assert.notEqual(a, b);
  });

  it('is sensitive to array order (arrays are not sorted)', () => {
    const a = computeRequestHash({ ids: ['a', 'b'] });
    const b = computeRequestHash({ ids: ['b', 'a'] });
    assert.notEqual(a, b);
  });

  it('returns a fixed-length hex digest', () => {
    const hash = computeRequestHash({ anything: true });
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]+$/);
  });
});
