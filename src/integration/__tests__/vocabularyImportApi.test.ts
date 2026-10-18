import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import crypto from 'crypto';
import { startTestServer, createTestAdminUser, prisma, TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { runGenerateNarrationJob } from '../../lib/textAudioPipeline';
import { readAudioAssetRange } from '../../lib/audioAssetStorage';
import { decodeWav } from '../../lib/pcmWav';
import { ReaderManifest } from '../../types/reader';
import { prepareLegacyClips } from './helpers/legacyClips';

describe('bulk vocabulary import and phrase publication', () => {
  let server: TestServer;
  let token: string;
  let restore: () => void;
  before(async () => { server = await startTestServer(); token = (await createTestAdminUser()).token; restore = installFakeElevenLabsFetch(); });
  after(async () => { restore(); await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method = 'GET', body?: unknown, headers = {}) {
    const response = await fetch(server.baseUrl + '/api' + path, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  async function fixture() {
    const created = await api('/lessons', 'POST', { title: 'Phrase import fixture', items: [{ text: 'We look after the cat. They look after the cat.' }] });
    assert.equal(created.status, 201);
    const lessonId = created.body.lesson.id, textId = created.body.lesson.items[0].id;
    const path = `/admin/lessons/${lessonId}/texts/${textId}`;
    const workspace = (await api(path)).body.text;
    const requested = await api(path + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id }, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(requested.status, 202);
    const job = await prisma.audioJob.update({ where: { id: requested.body.job.id }, data: { status: 'RUNNING' } });
    await runGenerateNarrationJob(prisma, job);
    const data = (await api(path + '/occurrences')).body;
    return { path, lessonId, textId, data, words: data.occurrences as { id: string; charStart: number; charEnd: number }[],
      import: (entries: unknown[], version = data.draftVersion) => api(path + '/vocabulary/import', 'POST', { alignmentId: data.alignmentId, expectedDraftVersion: version, entries }),
      publish: () => api(`/admin/lessons/${lessonId}/publish`, 'POST', {}) };
  }

  it('imports repeated phrases independently, publishes exact combined clips, and preserves pinned publications', async () => {
    const f = await fixture();
    const old = await f.publish(); assert.equal(old.status, 201);
    const oldPublication = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: old.body.publicationId } });
    const result = await f.import([
      { occurrenceId: f.words[1].id, endOccurrenceId: f.words[2].id, translation: 'հոգ տանել' },
      { occurrenceId: f.words[6].id, endOccurrenceId: f.words[7].id, translation: 'խնամել' },
      { occurrenceId: f.words[4].id, translation: 'կատու' },
    ]);
    assert.equal(result.status, 200); assert.equal(result.body.importedCount, 3);
    await prepareLegacyClips(prisma, f.textId);
    const published = await f.publish(); assert.equal(published.status, 201);
    const publication = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: published.body.publicationId } });
    const text = (publication.manifest as unknown as ReaderManifest).texts[0];
    assert.equal(text.occurrences.length, 8);
    const phrases = text.occurrences.filter(word => word.text === 'look after');
    assert.equal(phrases.length, 2);
    assert.deepEqual(phrases.map(word => word.learning!.translations[0].translation), ['հոգ տանել', 'խնամել']);
    assert.ok(!text.occurrences.some(word => [f.words[2].id, f.words[7].id].includes(word.id)));
    let cursor = 0, reconstructed = '';
    for (const word of text.occurrences) { reconstructed += text.text.slice(cursor, word.charStart) + word.text; cursor = word.charEnd; }
    assert.equal(reconstructed + text.text.slice(cursor), text.text);
    const narrationAsset = await prisma.audioAsset.findUniqueOrThrow({ where: { id: text.narration.id } });
    const narration = decodeWav(readAudioAssetRange(narrationAsset.storageKey, 0, narrationAsset.byteLength)!.buffer);
    for (const phrase of phrases) {
      const learning = phrase.learning!;
      const asset = await prisma.audioAsset.findUniqueOrThrow({ where: { id: learning.clip.id } });
      const clip = decodeWav(readAudioAssetRange(asset.storageKey, 0, asset.byteLength)!.buffer);
      assert.deepEqual(clip.samples, narration.samples.subarray(learning.cutStartSample, learning.cutEndSample));
      assert.equal(phrase.charEnd, f.words[phrase.id === f.words[1].id ? 2 : 7].charEnd);
    }
    assert.deepEqual((await prisma.lessonPublication.findUniqueOrThrow({ where: { id: old.body.publicationId } })).manifest, oldPublication.manifest);
    assert.equal((await f.publish()).body.publicationId, published.body.publicationId);
    assert.equal(await prisma.audioJob.count({ where: { textId: f.textId } }), 1, 'import and publication request no narration');
  });

  it('rejects invalid, foreign, backward, cross-sentence and duplicate ranges without partial writes', async () => {
    const f = await fixture(), other = await fixture();
    const valid = { occurrenceId: f.words[1].id, endOccurrenceId: f.words[2].id, translation: 'հոգ տանել' };
    for (const invalid of [
      { occurrenceId: other.words[0].id, translation: 'օտար' },
      { occurrenceId: f.words[6].id, endOccurrenceId: f.words[5].id, translation: 'հետ' },
      { occurrenceId: f.words[4].id, endOccurrenceId: f.words[5].id, translation: 'սխալ' },
      valid,
    ]) {
      assert.equal((await f.import([valid, invalid])).status, 422);
      assert.equal(await prisma.textVocabularyEntry.count({ where: { textId: f.textId } }), 0);
      assert.equal((await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: f.textId } })).draftVersion, f.data.draftVersion);
    }
    assert.equal((await f.import([{ ...valid, translation: ' ' }])).status, 400);
  });

  it('detects overlaps and stale previews, and serializes concurrent imports', async () => {
    const f = await fixture();
    const batch = [{ occurrenceId: f.words[1].id, endOccurrenceId: f.words[2].id, translation: 'հոգ տանել' }];
    const results = await Promise.all([f.import(batch), f.import(batch)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const fresh = (await api(f.path + '/occurrences')).body;
    assert.equal((await f.import([{ occurrenceId: f.words[2].id, translation: 'հետո' }], fresh.draftVersion)).status, 409);
    assert.equal((await f.import([{ occurrenceId: f.words[1].id, endOccurrenceId: f.words[2].id, translation: 'փոխել' }])).status, 409);
    const entries = await prisma.textVocabularyEntry.findMany({ where: { textId: f.textId }, include: { translations: true } });
    assert.equal(entries.length, 1); assert.equal(entries[0].translations[0].translation, 'հոգ տանել');
  });

  it('supports manual phrases, restores words after removal, and clears meaning when the range changes', async () => {
    const f = await fixture();
    const select = (selected: boolean, endOccurrenceId?: string) => api(f.path + '/selection', 'PATCH', {
      alignmentId: f.data.alignmentId, changes: [{ occurrenceId: f.words[1].id, endOccurrenceId, selected }],
    });
    assert.equal((await select(true, f.words[2].id)).status, 200);
    const fresh = (await api(f.path + '/occurrences')).body;
    assert.equal((await f.import([{ occurrenceId: f.words[1].id, endOccurrenceId: f.words[2].id, translation: 'հոգ տանել' }], fresh.draftVersion)).status, 200);
    await prepareLegacyClips(prisma, f.textId);
    assert.equal((await f.publish()).status, 201);
    assert.equal((await select(false)).status, 200);
    const removed = await f.publish();
    const publication = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: removed.body.publicationId } });
    assert.equal((publication.manifest as unknown as ReaderManifest).texts[0].occurrences.length, 10);
    assert.equal((await select(true)).status, 200);
    const entry = await prisma.textVocabularyEntry.findFirstOrThrow({ where: { textId: f.textId }, include: { translations: true } });
    assert.equal(entry.endOccurrenceId, null); assert.equal(entry.translations.length, 0);
    assert.equal((await f.publish()).status, 422);
  });

  it('rejects stale alignment and unreliable narration before writes', async () => {
    const f = await fixture();
    const batch = [{ occurrenceId: f.words[1].id, translation: 'նայել' }];
    await prisma.textAlignment.update({ where: { id: f.data.alignmentId }, data: { status: 'NEEDS_REVIEW' } });
    assert.equal((await f.import(batch)).status, 409);
    await api(f.path + '/content-revisions', 'POST', { text: 'A different text.' });
    assert.equal((await f.import(batch)).status, 409);
    assert.equal(await prisma.textVocabularyEntry.count({ where: { textId: f.textId } }), 0);
  });
});
