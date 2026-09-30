import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { parseByteRange } from '../servePrivateAudio';

it('serves full, inclusive, suffix and open-ended ranges with HTTP-compatible bounds', () => {
  assert.deepEqual(parseByteRange(undefined, 100), { start: 0, end: 100, status: 200 });
  assert.deepEqual(parseByteRange('bytes=0-3', 100), { start: 0, end: 4, status: 206 });
  assert.deepEqual(parseByteRange('bytes=-4', 100), { start: 96, end: 100, status: 206 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 100, status: 206 });
  assert.deepEqual(parseByteRange('bytes=90-200', 100), { start: 90, end: 100, status: 206 });
});
it('rejects empty, reversed, multi-range and unsatisfiable requests', () => {
  for (const value of ['bytes=-', 'bytes=-0', 'bytes=100-', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=90071992547409999-'])
    assert.equal(parseByteRange(value, 100), null, value);
});
