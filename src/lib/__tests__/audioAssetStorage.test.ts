import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeAudioAsset,
  readAudioAssetRange,
  resolveAssetStorageKey,
  AUDIO_AUTHORING_ROOT_ENV,
} from '../audioAssetStorage';

describe('audioAssetStorage', () => {
  let tmpRoot: string;
  const previousRoot = process.env[AUDIO_AUTHORING_ROOT_ENV];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-authoring-test-'));
    process.env[AUDIO_AUTHORING_ROOT_ENV] = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (previousRoot === undefined) {
      delete process.env[AUDIO_AUTHORING_ROOT_ENV];
    } else {
      process.env[AUDIO_AUTHORING_ROOT_ENV] = previousRoot;
    }
  });

  it('stages then atomically renames into place, hashing the exact bytes written', async () => {
    const bytes = Buffer.from('hello world audio bytes');
    const result = await writeAudioAsset({ textId: 'text-1', kind: 'NARRATION', bytes });

    assert.equal(result.byteLength, bytes.length);
    assert.equal(result.sha256.length, 64);
    const resolvedPath = resolveAssetStorageKey(result.storageKey);
    assert.ok(resolvedPath && fs.existsSync(resolvedPath));
    const onDisk = fs.readFileSync(resolvedPath!);
    assert.deepEqual(onDisk, bytes);
  });

  it('writes outside any public/ directory', async () => {
    const bytes = Buffer.from('private');
    const result = await writeAudioAsset({ textId: 'text-1', kind: 'WORD_CLIP', bytes });
    const resolvedPath = resolveAssetStorageKey(result.storageKey)!;
    assert.doesNotMatch(resolvedPath, /\bpublic\b/);
  });

  it('rejects a storage key that attempts path traversal', () => {
    assert.equal(resolveAssetStorageKey('../../etc/passwd'), null);
    assert.equal(resolveAssetStorageKey('text-1/../../secret'), null);
  });

  it('supports byte-range reads for HTTP range requests', async () => {
    const bytes = Buffer.from('0123456789');
    const result = await writeAudioAsset({ textId: 'text-1', kind: 'NARRATION', bytes });
    const range = readAudioAssetRange(result.storageKey, 2, 5);
    assert.ok(range);
    assert.deepEqual(range!.buffer, Buffer.from('234'));
    assert.equal(range!.totalLength, 10);
  });

  it('returns null for a missing asset instead of throwing', () => {
    assert.equal(readAudioAssetRange('does-not-exist', 0, 1), null);
  });
});
