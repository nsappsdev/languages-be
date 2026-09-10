import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { planLessonItemReconciliation, type ExistingLessonItemRef, type IncomingLessonItem } from '../lessonItemReconciliation';

function existing(id: string, order: number): ExistingLessonItemRef {
  return { id, order, lessonId: 'lesson-1' };
}

function incoming(partial: Partial<IncomingLessonItem> & { text: string }): IncomingLessonItem {
  return {
    id: undefined,
    order: 0,
    audioUrl: '',
    segments: [],
    wordTimings: [],
    sentenceTimings: [],
    chunkTimings: [],
    ...partial,
  };
}

describe('planLessonItemReconciliation', () => {
  it('updates retained rows in place and preserves their existing id', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0), existing('item-2', 1)],
      incomingItems: [
        incoming({ id: 'item-1', text: 'Updated text A', order: 0 }),
        incoming({ id: 'item-2', text: 'Updated text B', order: 1 }),
      ],
    });

    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.updates.length, 2);
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.archives.length, 0);
    assert.deepEqual(
      plan.updates.map((u) => u.id),
      ['item-1', 'item-2'],
    );
  });

  it('creates genuinely new rows for unknown client-generated ids or omitted ids', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0)],
      incomingItems: [incoming({ id: 'item-1', text: 'A', order: 0 }), incoming({ text: 'B', order: 1 })],
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].id, undefined);
  });

  it('rejects a supplied id that belongs to a different lesson instead of silently moving it', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0)],
      incomingItems: [incoming({ id: 'item-1', text: 'A', order: 0 })],
      foreignItemIds: new Set(['item-1']),
    });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.error, /foreign/i);
  });

  it('rejects duplicate ids within the same request', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0)],
      incomingItems: [incoming({ id: 'item-1', text: 'A', order: 0 }), incoming({ id: 'item-1', text: 'B', order: 1 })],
    });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.error, /duplicate/i);
  });

  it('archives items omitted from a supplied full array rather than deleting them', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0), existing('item-2', 1)],
      incomingItems: [incoming({ id: 'item-1', text: 'A', order: 0 })],
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(
      plan.archives.map((a) => a.id),
      ['item-2'],
    );
  });

  it('assigns safe non-colliding negative orders to archived rows and nonnegative orders to active rows', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0), existing('item-2', 1)],
      incomingItems: [incoming({ id: 'item-1', text: 'A', order: 0 })],
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.archives[0].archivedOrder < 0);
    assert.ok(plan.updates.every((u) => u.order >= 0));
  });

  it('produces a stable transaction-local reorder sequence avoiding unique(lessonId,order) collisions on swap', () => {
    // Swap orders of two existing items: item-1 (order 0) <-> item-2 (order 1)
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0), existing('item-2', 1)],
      incomingItems: [
        incoming({ id: 'item-1', text: 'A', order: 1 }),
        incoming({ id: 'item-2', text: 'B', order: 0 }),
      ],
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    // Every entry in the reorder-safe staging step must have a unique negative placeholder order.
    const placeholderOrders = plan.stagingOrders.map((s) => s.placeholderOrder);
    assert.equal(new Set(placeholderOrders).size, placeholderOrders.length);
    assert.ok(placeholderOrders.every((o) => o < 0));
  });

  it('rejects negative client-supplied order values', () => {
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [],
      incomingItems: [incoming({ text: 'A', order: -1 })],
    });
    assert.equal(plan.ok, false);
  });

  it('treats omitted items property (undefined incomingItems) upstream as no-op, not this function’s concern', () => {
    // planLessonItemReconciliation always receives a concrete array; the "omitted items = no change"
    // rule is enforced by the route before calling this function. Empty array here means "archive all".
    const plan = planLessonItemReconciliation({
      lessonId: 'lesson-1',
      existingItems: [existing('item-1', 0)],
      incomingItems: [],
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.archives.length, 1);
  });
});
