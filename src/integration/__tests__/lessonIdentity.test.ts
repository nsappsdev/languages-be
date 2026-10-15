import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startTestServer, createTestAdminUser, prisma, type TestServer } from './helpers/authoringTestApp';

describe('transactional lesson creation and stable ordered text identities', () => {
  let server: TestServer;
  let token: string;
  before(async () => { server = await startTestServer(); token = (await createTestAdminUser()).token; });
  after(async () => { await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method: string, input: unknown) {
    const res = await fetch(server.baseUrl + '/api' + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json() as any };
  }
  async function create() {
    const result = await api('/lessons', 'POST', { title: 'Identity lesson', description: 'Preserved', items: [{ text: 'Alpha.' }, { text: 'Beta.' }] });
    assert.equal(result.status, 201);
    return result.body.lesson;
  }
  it('creates initial revisions and no narration jobs, preserves text/history when reordering and archiving', async () => {
    const lesson = await create();
    const [a, b] = lesson.items;
    const workspaces = await prisma.textWorkspace.findMany({ where: { textId: { in: [a.id, b.id] } }, include: { contentRevisions: true } });
    assert.equal(workspaces.length, 2);
    for (const ws of workspaces) { assert.equal(ws.contentRevisions.length, 1); assert.equal(ws.currentContentRevisionId, ws.contentRevisions[0].id); }
    assert.equal(await prisma.audioJob.count({ where: { textId: { in: [a.id, b.id] } } }), 0);
    // An explicitly seeded historical row proves that existing data survives.
    const historical = await prisma.lessonVocabularyEntry.create({ data: { lessonId: lesson.id, sourceItemId: b.id, englishText: 'Beta', normalizedText: 'beta', order: 0 } });
    const swap = await api(`/lessons/${lesson.id}`, 'PATCH', { items: [{ id: b.id }, { id: a.id }] });
    assert.equal(swap.status, 200);
    assert.deepEqual(swap.body.lesson.items.map((i: any) => [i.id, i.order, i.text]), [[b.id, 0, 'Beta.'], [a.id, 1, 'Alpha.']]);
    const removed = await api(`/lessons/${lesson.id}`, 'PATCH', { items: [{ id: a.id }] });
    assert.equal(removed.status, 200);
    assert.ok((await prisma.lessonItem.findUniqueOrThrow({ where: { id: b.id } })).archivedAt);
    assert.equal((await prisma.lessonVocabularyEntry.findUniqueOrThrow({ where: { id: historical.id } })).sourceItemId, b.id);
    const added = await api(`/lessons/${lesson.id}/items`, 'POST', { text: 'Gamma.' });
    assert.equal(added.status, 201);
    assert.ok((await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: added.body.item.id } })).currentContentRevisionId);
  });
  it('rejects duplicate, unknown, and foreign identities without changing metadata', async () => {
    const one = await create(); const two = await create();
    for (const items of [[{ id: one.items[0].id }, { id: one.items[0].id }], [{ id: 'unknown' }], [{ id: two.items[0].id }]]) {
      assert.equal((await api(`/lessons/${one.id}`, 'PATCH', { title: 'Should roll back', items })).status, 409);
      assert.equal((await prisma.lesson.findUniqueOrThrow({ where: { id: one.id } })).title, 'Identity lesson');
    }
  });
  it('uses only content revisions for edits and never treats the historical status as visibility', async () => {
    const lesson = await create(); const a = lesson.items[0];
    assert.equal((await api(`/lessons/${lesson.id}`, 'PATCH', { items: [{ id: a.id, text: 'Second editor' }] })).status, 400);
    assert.equal((await api(`/lessons/${lesson.id}`, 'PATCH', { status: 'PUBLISHED' })).status, 400);
    await prisma.lesson.update({ where: { id: lesson.id }, data: { status: 'PUBLISHED' } });
    const response = await fetch(server.baseUrl + '/api/lessons/' + lesson.id, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await response.json() as any).lesson.status, 'DRAFT');
    const updated = await api(`/admin/lessons/${lesson.id}/texts/${a.id}/content-revisions`, 'POST', { text: 'New authoritative text.' });
    assert.equal(updated.status, 201);
    assert.equal((await prisma.lessonItem.findUniqueOrThrow({ where: { id: a.id } })).text, 'Alpha.', 'bootstrap mirror is not a second editable source');
    const read = await fetch(server.baseUrl + '/api/lessons/' + lesson.id, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await read.json() as any).lesson.items[0].text, 'New authoritative text.');
  });
});
