/**
 * Per-column session isolation resolution.
 *
 * A task can run on multiple parallel, independently-resumable sessions. Normal
 * columns share the task's main session (resumed as the task moves between them).
 * A column with session_strategy='isolated' runs the task on its own separate,
 * context-isolated session, keyed by the swimlane id, so re-entering that column
 * resumes its own conversation while leaving it for a non-isolated column resumes
 * the main session.
 *
 * The discriminator on each session record is `isolated_swimlane_id`: null for the
 * main session, or the swimlane id of the isolated column. These are pure
 * functions with no side effects - easy to unit test. They are the single source
 * of truth for the isolation-keying rule, so every spawn / recovery site stays
 * consistent and a future strategy change touches one place.
 */

import type { Swimlane, SessionStrategy } from '../../shared/types';

/**
 * The effective session strategy for a column. Null/undefined (legacy rows, or a
 * column created before this feature) resolves to 'main', reproducing today's
 * behavior exactly.
 */
export function resolveSessionStrategy(
  lane: Pick<Swimlane, 'session_strategy'> | null | undefined,
): SessionStrategy {
  return lane?.session_strategy ?? 'main';
}

/**
 * The swimlane a task's session is isolated to while it sits in this column: the
 * swimlane id for an 'isolated'-strategy column, or null (the main session) for
 * every other column.
 */
export function resolveIsolatedSwimlaneId(
  lane: Pick<Swimlane, 'id' | 'session_strategy'> | null | undefined,
): string | null {
  if (lane && resolveSessionStrategy(lane) === 'isolated') return lane.id;
  return null;
}
