import { describe, it, expect } from 'vitest';
import { createGate, canPersist } from '../../src/renderer/stores/board-store/completion-gate';
import type { CompletingTask } from '../../src/renderer/stores/board-store/types';
import type { Task } from '../../src/shared/types';

// The completion gate joins two independent signals (animation finished + move
// approved) so a Done drop persists exactly once, no matter which signal lands
// last. These tests lock that join: both signals required, double-persist
// guarded, and the ungated (pre-approved) shortcut.

function makeCompleting(taskId: string): CompletingTask {
  const task = { id: taskId, title: 'T', swimlane_id: 'src', position: 0 } as unknown as Task;
  return {
    taskId,
    targetSwimlaneId: 'done',
    targetPosition: 0,
    originSwimlaneId: 'src',
    task,
    startRect: { left: 0, top: 0, width: 100, height: 40 },
  };
}

describe('completion gate', () => {
  it('a gated gate is not approved on creation and cannot persist', () => {
    const gate = createGate(makeCompleting('a'), true);
    expect(gate.approved).toBe(false);
    expect(gate.animationDone).toBe(false);
    expect(canPersist(gate)).toBe(false);
  });

  it('an ungated gate is pre-approved but still waits for the animation', () => {
    const gate = createGate(makeCompleting('a'), false);
    expect(gate.approved).toBe(true);
    expect(canPersist(gate)).toBe(false);
  });

  it('persists only once both signals have arrived (animation first)', () => {
    const gate = createGate(makeCompleting('a'), true);
    gate.animationDone = true;
    expect(canPersist(gate)).toBe(false);
    gate.approved = true;
    expect(canPersist(gate)).toBe(true);
  });

  it('persists only once both signals have arrived (approval first)', () => {
    const gate = createGate(makeCompleting('a'), true);
    gate.approved = true;
    expect(canPersist(gate)).toBe(false);
    gate.animationDone = true;
    expect(canPersist(gate)).toBe(true);
  });

  it('an ungated gate persists as soon as the animation is done', () => {
    const gate = createGate(makeCompleting('a'), false);
    gate.animationDone = true;
    expect(canPersist(gate)).toBe(true);
  });

  it('does not re-persist once persistStarted is set (double-fire guard)', () => {
    const gate = createGate(makeCompleting('a'), false);
    gate.animationDone = true;
    expect(canPersist(gate)).toBe(true);
    gate.persistStarted = true;
    expect(canPersist(gate)).toBe(false);
  });

  it('keeps its own completing payload', () => {
    const completing = makeCompleting('a');
    const gate = createGate(completing, true);
    expect(gate.completing).toBe(completing);
  });
});
