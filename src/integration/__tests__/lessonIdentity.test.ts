import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startTestServer, createTestAdminUser, prisma, type TestServer } from './helpers/authoringTestApp';

describe('lesson item identity (PATCH /lessons/:id)', () => {
  let server: TestServer;
  let token: string;

  before(async () => {
    server = await startTestServer();
    const admin = await createTestAdminUser();
    token = admin.token;
  });

  after(async () => {
    await server.close();
  });

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${server.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  function item(text: string, order: number) {
    return { text, audioUrl: '', order, segments: [{ text, startMs: 0, endMs: 1000 }] };
  }

  it('preserves stable item ids across a full save and archives omitted items instead of deleting them', async () => {
    const created = await api('/api/lessons', {
      method: 'POST',
      body: JSON.stringify({ title: 'Identity Lesson', items: [item('Alpha', 0), item('Beta', 1)] }),
    });
    assert.equal(created.status, 201);
    const lessonId = created.body.lesson.id;
    const [itemA, itemB] = created.body.lesson.items;

    // A legacy vocabulary entry sourced from item A, to prove the FK survives a save.
    const vocabEntry = await prisma.lessonVocabularyEntry.create({
      data: {
        lessonId,
        sourceItemId: itemA.id,
        englishText: 'Alpha',
        normalizedText: 'alpha',
        order: 0,
      },
    });

    // Save with item A updated in place, item B omitted (archived), and a new item C added.
    const updated = await api(`/api/lessons/${lessonId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        items: [{ ...item('Alpha updated', 0), id: itemA.id }, item('Gamma', 1)],
      }),
    });

    assert.equal(updated.status, 200);
    const returnedIds = updated.body.lesson.items.map((i: any) => i.id);
    assert.ok(returnedIds.includes(itemA.id), 'item A id must survive the save');
    assert.equal(updated.body.lesson.items.length, 2);
    assert.equal(updated.body.lesson.items.find((i: any) => i.id === itemA.id).text, 'Alpha updated');

    const dbItemB = await prisma.lessonItem.findUnique({ where: { id: itemB.id } });
    assert.ok(dbItemB, 'item B row must still exist (archived, not deleted)');
    assert.ok(dbItemB!.archivedAt, 'item B must be archived');

    const dbVocab = await prisma.lessonVocabularyEntry.findUnique({ where: { id: vocabEntry.id } });
    assert.equal(dbVocab!.sourceItemId, itemA.id, 'source item FK must survive the save, not be SET NULL by delete/recreate');
  });

  it('rejects a supplied item id that belongs to a different lesson', async () => {
    const lessonOne = await api('/api/lessons', { method: 'POST', body: JSON.stringify({ title: 'Lesson One', items: [item('One', 0)] }) });
    const lessonTwo = await api('/api/lessons', { method: 'POST', body: JSON.stringify({ title: 'Lesson Two', items: [item('Two', 0)] }) });
    const foreignId = lessonOne.body.lesson.items[0].id;

    const attempt = await api(`/api/lessons/${lessonTwo.body.lesson.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: [{ ...item('Hijacked', 0), id: foreignId }] }),
    });
    assert.equal(attempt.status, 409);
  });

  it('swaps two active items orders without unique constraint collisions', async () => {
    const created = await api('/api/lessons', {
      method: 'POST',
      body: JSON.stringify({ title: 'Swap Lesson', items: [item('First', 0), item('Second', 1)] }),
    });
    const [a, b] = created.body.lesson.items;

    const swapped = await api(`/api/lessons/${created.body.lesson.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        items: [
          { ...item('First', 1), id: a.id },
          { ...item('Second', 0), id: b.id },
        ],
      }),
    });
    assert.equal(swapped.status, 200);
    const byId = Object.fromEntries(swapped.body.lesson.items.map((i: any) => [i.id, i.order]));
    assert.equal(byId[a.id], 1);
    assert.equal(byId[b.id], 0);
  });
});
