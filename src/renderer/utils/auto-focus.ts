import { ACTIVITY_TAB } from '../../shared/types';
import type { ActivityState, SessionStatus } from '../../shared/types';

interface AutoFocusInput {
  sessionId: string;
  newState: ActivityState;
  currentActiveSessionId: string | null;
  dialogSessionId: string | null;
  sessionActivity: Record<string, ActivityState>;
  // projectId is not used by auto-focus; optional so Session[] is assignable
  sessions: Array<{ id: string; status: SessionStatus; projectId?: string }>;
}

/**
 * Given a session activity change, determine whether the bottom panel should
 * auto-switch to a different tab. Returns the target session ID to switch to,
 * or null if no switch is needed.
 */
export function resolveAutoFocusTarget(input: AutoFocusInput): string | null {
  const { sessionId, newState, currentActiveSessionId, dialogSessionId, sessionActivity, sessions } = input;

  // Activity tab is sacred -- never switch away from it
  if (currentActiveSessionId === ACTIVITY_TAB) {
    return null;
  }

  // Task Detail dialog is open -- user is in a focused view, don't interrupt
  if (dialogSessionId !== null) {
    return null;
  }

  // Treat 'permission' like 'idle' for focus purposes - the agent is paused
  // and the user should see it. The renderer differentiates the two visually
  // (lock icon vs idle dot) but both qualify as "ready for user attention".
  const isPaused = (state: ActivityState) => state === 'idle' || state === 'permission';

  if (isPaused(newState)) {
    // Don't switch if user is already viewing a running paused session
    const isViewingPausedSession =
      currentActiveSessionId !== null &&
      isPaused(sessionActivity[currentActiveSessionId] ?? 'idle') &&
      sessions.some((s) => s.id === currentActiveSessionId && s.status === 'running');
    if (!isViewingPausedSession) {
      return sessionId;
    }
    return null;
  }

  // newState === 'thinking' -- only react if the viewed session went to thinking
  if (currentActiveSessionId === sessionId) {
    const otherPaused = sessions.find(
      (s) => s.id !== sessionId && s.status === 'running' && isPaused(sessionActivity[s.id] ?? 'idle'),
    );
    return otherPaused?.id ?? null;
  }

  return null;
}
