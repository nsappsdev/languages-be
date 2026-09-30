/**
 * Pure planning logic for replacing the previous delete-then-recreate full
 * lesson item save with an in-place diff/reconciliation. No DB access here;
 * the route applies this plan inside one transaction (see lessons.ts).
 *
 * This exists specifically to preserve stable LessonItem IDs across a full
 * save so that FK references (vocabulary sourceItemId, and the new
 * TextWorkspace 1:1 relation) never get silently orphaned by a delete/recreate
 * cycle, even when the client resubmits the same ID.
 */

export interface ExistingLessonItemRef {
  id: string;
  order: number;
  lessonId: string;
}

export interface IncomingLessonItem {
  id?: string;
  order: number;
  text: string;
  audioUrl: string;
  segments: unknown;
  wordTimings: unknown;
  sentenceTimings: unknown;
  chunkTimings: unknown;
}

export interface UpdatePlanItem extends IncomingLessonItem {
  id: string;
}

export interface CreatePlanItem extends IncomingLessonItem {}

export interface ArchivePlanItem {
  id: string;
  archivedOrder: number;
}

export interface StagingOrderEntry {
  id: string;
  placeholderOrder: number;
  finalOrder: number;
}

export interface ReconciliationInput {
  lessonId: string;
  existingItems: ExistingLessonItemRef[];
  incomingItems: IncomingLessonItem[];
  /** IDs that are known to already exist but belong to a different lesson/resource. */
  foreignItemIds?: Set<string>;
  /**
   * Highest (least negative) order value the caller has confirmed is safe to
   * use for a newly archived row this transaction, e.g. `min(existing order
   * values, previously archived included) - 1`. Defaults to -1 for callers
   * (tests) that don't track prior archive history.
   */
  archiveOrderCeiling?: number;
}

export type ReconciliationPlan =
  | {
      ok: true;
      updates: UpdatePlanItem[];
      creates: CreatePlanItem[];
      archives: ArchivePlanItem[];
      stagingOrders: StagingOrderEntry[];
    }
  | { ok: false; error: string };

export function planLessonItemReconciliation(input: ReconciliationInput): ReconciliationPlan {
  const { existingItems, incomingItems, foreignItemIds, archiveOrderCeiling = -1 } = input;

  for (const item of incomingItems) {
    if (item.order < 0) {
      return { ok: false, error: 'Item order must be nonnegative' };
    }
  }

  const seenIds = new Set<string>();
  for (const item of incomingItems) {
    if (item.id) {
      if (seenIds.has(item.id)) {
        return { ok: false, error: `Duplicate item id in request: ${item.id}` };
      }
      seenIds.add(item.id);
    }
  }

  if (foreignItemIds) {
    for (const item of incomingItems) {
      if (item.id && foreignItemIds.has(item.id)) {
        return {
          ok: false,
          error: `Item id ${item.id} is a foreign id already owned by another lesson or resource`,
        };
      }
    }
  }

  const existingById = new Map(existingItems.map((entry) => [entry.id, entry]));
  const updates: UpdatePlanItem[] = [];
  const creates: CreatePlanItem[] = [];

  for (const item of incomingItems) {
    if (item.id && existingById.has(item.id)) {
      updates.push({ ...item, id: item.id });
    } else {
      creates.push({ ...item });
    }
  }

  const retainedIds = new Set(updates.map((update) => update.id));
  const archives: ArchivePlanItem[] = [];
  let archiveIndex = 0;
  for (const existing of existingItems) {
    if (!retainedIds.has(existing.id)) {
      archives.push({ id: existing.id, archivedOrder: archiveOrderCeiling - archiveIndex });
      archiveIndex += 1;
    }
  }

  // Staging placeholders sit strictly below every archive value used in this
  // batch, so the two-phase "move to placeholder, then set final order"
  // update never collides with unique(lessonId, order) against archived rows
  // either.
  const stagingFloor = archiveOrderCeiling - archiveIndex;
  const stagingOrders: StagingOrderEntry[] = updates.map((update, index) => ({
    id: update.id,
    placeholderOrder: stagingFloor - 1 - index,
    finalOrder: update.order,
  }));

  return { ok: true, updates, creates, archives, stagingOrders };
}
