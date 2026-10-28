import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';

describe('lesson deletion retains history and prevents future authoring', () => {
  let server: TestServer;
  let admin: Awaited<ReturnType<typeof createTestAdminUser>>;
  let learnerToken: string;
  before(async () => {
    server = await startTestServer(); admin = await createTestAdminUser();
    const learner = await prisma.user.create({ data: { name: 'Deletion test', email: `deletion-${crypto.randomUUID()}@example.test`, role: 'learner' } });
    learnerToken = jwt.sign({ sub: learner.id }, config.jwtSecret, { expiresIn: '1h' });
  });
  after(async () => { await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method = 'GET', input?: unknown, token = admin.token) {
    const response = await fetch(server.baseUrl + '/api' + path, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }
  async function create() {
    const result = await api('/lessons', 'POST', { title: 'Delete this lesson', items: [{ text: 'Keep its history.' }, { text: 'Another text.' }] });
    assert.equal(result.status, 201);
    return result.body.lesson;
  }

  it('restricts deletion to authenticated admins', async () => {
    const lesson = await create();
    assert.equal((await api(`/lessons/${lesson.id}`, 'DELETE', undefined, '')).status, 401);
    assert.equal((await api(`/lessons/${lesson.id}`, 'DELETE', undefined, learnerToken)).status, 403);
    assert.equal((await api(`/lessons/${lesson.id}`)).status, 200);
    assert.equal((await api('/lessons/does-not-exist', 'DELETE')).status, 404);
  });

  it('removes drafts from lists and analytics while retaining revisions and blocking old URLs and writes', async () => {
    const lesson = await create(), item = lesson.items[0];
    const workspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: item.id } });
    const before = (await api('/analytics/overview')).body.stats;
    assert.equal((await api(`/lessons/${lesson.id}`, 'DELETE')).status, 204);
    assert.ok((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).archivedAt);
    assert.equal((await api('/lessons')).body.lessons.some((l: any) => l.id === lesson.id), false);
    assert.equal((await api('/analytics/overview')).body.stats.totalLessons, before.totalLessons - 1);
    assert.equal((await api('/analytics/overview')).body.stats.totalItems, before.totalItems - 2);
    assert.equal(await prisma.textContentRevision.count({ where: { id: workspace.currentContentRevisionId! } }), 1);
    assert.equal(await prisma.lessonItem.count({ where: { lessonId: lesson.id, archivedAt: { not: null } } }), 2);
    assert.equal(await prisma.textWorkspace.count({ where: { item: { lessonId: lesson.id }, archivedAt: { not: null } } }), 2);
    const base = `/admin/lessons/${lesson.id}/texts/${item.id}`;
    for (const [path, method, data] of [
      [`/lessons/${lesson.id}`, 'GET', undefined],
      [`/lessons/${lesson.id}`, 'PATCH', { title: 'Resurrected' }],
      [`/lessons/${lesson.id}/items`, 'POST', { text: 'Not allowed.' }],
      [`/admin/lessons/${lesson.id}/publish`, 'POST', {}],
      [`/admin/lessons/${lesson.id}/unpublish`, 'POST', {}],
      [base, 'GET', undefined],
      [base + '/content-revisions', 'POST', { text: 'Not allowed.' }],
      [base + '/vocabulary/audio-plan', 'GET', undefined],
    ] as const) assert.equal((await api(path, method, data)).status, 404, `${method} ${path}`);
    assert.equal((await api(`/lessons/${lesson.id}`, 'DELETE')).status, 404);
  });

  it('blocks queued and running audio even for a previously removed text, without partially deleting', async () => {
    const lesson = await create(), item = lesson.items[1];
    await api(`/lessons/${lesson.id}`, 'PATCH', { items: [{ id: lesson.items[0].id }] });
    const job = await prisma.audioJob.create({ data: { textId: item.id, actorId: admin.user.id, kind: 'GENERATE_NARRATION',
      idempotencyKey: crypto.randomUUID(), requestHash: 'test', requestPayload: {} } });
    for (const status of ['QUEUED', 'RUNNING'] as const) {
      await prisma.audioJob.update({ where: { id: job.id }, data: { status } });
      const response = await api(`/lessons/${lesson.id}`, 'DELETE');
      assert.equal(response.status, 409); assert.match(response.body.message, /Audio is still being prepared/);
      assert.equal((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).archivedAt, null);
      assert.equal((await prisma.lessonItem.findUniqueOrThrow({ where: { id: lesson.items[0].id } })).archivedAt, null);
    }
    await prisma.audioJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED' } });
    assert.equal((await api(`/lessons/${lesson.id}`, 'DELETE')).status, 204);
  });

  it('serializes deletion against concurrent edits so the lesson cannot be revived', async () => {
    const lesson = await create();
    const results = await Promise.all([
      api(`/lessons/${lesson.id}`, 'DELETE'),
      api(`/lessons/${lesson.id}`, 'PATCH', { title: 'Concurrent edit' }),
      api(`/lessons/${lesson.id}/items`, 'POST', { text: 'Concurrent new text.' }),
    ]);
    assert.equal(results[0].status, 204);
    assert.ok([200, 404].includes(results[1].status));
    assert.ok([201, 404].includes(results[2].status));
    assert.equal((await api(`/lessons/${lesson.id}`)).status, 404);
    assert.equal(await prisma.lessonItem.count({ where: { lessonId: lesson.id, archivedAt: null } }), 0);
  });
});
