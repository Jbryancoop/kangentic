/**
 * Decides when a session deserves a push notification, seals the real
 * content into an E2E envelope per registered device, and hands the
 * opaque blob to the Expo client. Three triggers, keyed off
 * SessionManager's activity/exit emissions:
 *
 * - transition INTO 'permission': 'permission-needed', or
 *   'agent-question' when the awaited prompt is an AskUserQuestion
 *   (resolved by matching the awaited tool_use_id against the session's
 *   cached tool_start events). Debounced 2s and re-checked at fire time,
 *   so a prompt the user answers at the desk within the debounce never
 *   pings their phone.
 * - transition 'thinking' -> 'idle': 'turn-complete'.
 * - exit with intentional false (a crash, including the flag-less
 *   spawn-failure emit): 'session-failed'. A deliberate stop never
 *   notifies.
 *
 * Per registered device: presence suppression (an established bridge
 * session means the user is already watching from that device), then a
 * 30s per (device, session, category) cooldown. Only data.blob carries
 * real content; the visible title/body are static per-category
 * placeholders. A DeviceNotRegistered ticket drops the registration.
 */
import { hexToBytes, sealPushEnvelope, type PushCategory, type PushEnvelopePlaintext } from '@kangentic/protocol';
import type { ActivityReason, ActivityState } from '../../../shared/types';
import type { SessionManager } from '../../pty/session-manager';
import type { PushRegistrationStore } from './push-registration-store';
import { sendExpoPush, type FetchLike } from './expo-push-client';

const PERMISSION_DEBOUNCE_MS = 2000;
const CATEGORY_COOLDOWN_MS = 30_000;
const NOTIFICATION_TITLE = 'Kangentic';
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** OS-visible placeholder body per category - never real content. */
const PLACEHOLDER_BODIES: Record<PushCategory, string> = {
  'permission-needed': 'Agent needs your attention',
  'agent-question': 'Agent needs your attention',
  'turn-complete': 'Task update',
  'session-failed': 'Session stopped',
};

/** Android notification channel per category (mirrored by the app's Notifee channel setup). */
const CHANNEL_IDS: Record<PushCategory, string> = {
  'permission-needed': 'needs-attention',
  'agent-question': 'needs-attention',
  'turn-complete': 'completions',
  'session-failed': 'failures',
};

export interface PushTaskContext {
  projectId: string;
  taskId: string;
  taskTitle: string;
}

export interface PushNotifierOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off' | 'getActivityStatsSnapshot' | 'getEventsForSession'>;
  registrationStore: Pick<PushRegistrationStore, 'list' | 'remove'>;
  /** Devices with a live established bridge session - already watching, never pinged. */
  getEstablishedDeviceIds: () => Set<string>;
  resolveTaskContext: (sessionId: string) => PushTaskContext | null;
  /** The device's roster static public key, sealed into every envelope as AAD. Null means "unknown device, skip". */
  getDeviceStaticPublicKey: (deviceId: string) => Uint8Array | null;
  /** Injectable for tests; defaults to the protocol package's sealPushEnvelope. */
  sealEnvelope?: typeof sealPushEnvelope;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly sealEnvelope: typeof sealPushEnvelope;
  private readonly fetchImpl: FetchLike;
  private readonly lastActivityState = new Map<string, ActivityState>();
  private readonly permissionDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last-notified wall-clock ms per `${deviceId}|${sessionId}|${category}`. */
  private readonly cooldowns = new Map<string, number>();
  private started = false;
  private disposed = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.sealEnvelope = options.sealEnvelope ?? sealPushEnvelope;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly onActivity = (sessionId: string, state: ActivityState, _reason: ActivityReason): void => {
    const previousState = this.lastActivityState.get(sessionId);
    this.lastActivityState.set(sessionId, state);
    if (state === previousState) return;

    if (state === 'permission') {
      this.schedulePermissionNotification(sessionId);
      return;
    }
    // Left permission (answered at the desk, or the turn moved on):
    // cancel a pending debounce so the fire-time re-check never even runs.
    this.clearPermissionDebounce(sessionId);
    if (previousState === 'thinking' && state === 'idle') {
      this.notify(sessionId, 'turn-complete', '');
    }
  };

  private readonly onExit = (sessionId: string, exitCode: number, intentional?: boolean): void => {
    this.lastActivityState.delete(sessionId);
    this.clearPermissionDebounce(sessionId);
    // The spawn-failure path emits no flag; a spawn failure is not a
    // deliberate stop, so only an explicit true suppresses.
    if (intentional === true) return;
    this.notify(sessionId, 'session-failed', `exit code ${exitCode}`);
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.sessionManager.on('activity', this.onActivity);
    this.options.sessionManager.on('exit', this.onExit);
  }

  private schedulePermissionNotification(sessionId: string): void {
    if (this.permissionDebounceTimers.has(sessionId)) return;
    const debounceTimer = setTimeout(() => {
      this.permissionDebounceTimers.delete(sessionId);
      // Re-check at fire time: a prompt answered within the debounce
      // window must not ping the phone.
      const statsSnapshot = this.options.sessionManager.getActivityStatsSnapshot(sessionId);
      if (!statsSnapshot?.permissionPending) return;
      const awaitedToolName = this.resolveAwaitedToolName(sessionId, statsSnapshot.permissionAwaitedToolId);
      const category: PushCategory = awaitedToolName === ASK_USER_QUESTION_TOOL ? 'agent-question' : 'permission-needed';
      this.notify(sessionId, category, awaitedToolName ?? '');
    }, PERMISSION_DEBOUNCE_MS);
    debounceTimer.unref?.();
    this.permissionDebounceTimers.set(sessionId, debounceTimer);
  }

  /** The awaited prompt's tool name, from the session's cached tool_start events (a bounded array; scanned newest-first). */
  private resolveAwaitedToolName(sessionId: string, awaitedToolId: string | null): string | null {
    if (!awaitedToolId) return null;
    const events = this.options.sessionManager.getEventsForSession(sessionId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.type === 'tool_start' && event.toolId === awaitedToolId) return event.tool ?? null;
    }
    return null;
  }

  private clearPermissionDebounce(sessionId: string): void {
    const debounceTimer = this.permissionDebounceTimers.get(sessionId);
    if (!debounceTimer) return;
    clearTimeout(debounceTimer);
    this.permissionDebounceTimers.delete(sessionId);
  }

  private notify(sessionId: string, category: PushCategory, detail: string): void {
    if (this.disposed) return;
    const taskContext = this.options.resolveTaskContext(sessionId);
    if (!taskContext) return;
    const establishedDeviceIds = this.options.getEstablishedDeviceIds();
    const now = Date.now();

    for (const registration of this.options.registrationStore.list()) {
      if (establishedDeviceIds.has(registration.deviceId)) continue;

      const cooldownKey = `${registration.deviceId}|${sessionId}|${category}`;
      const lastNotifiedAt = this.cooldowns.get(cooldownKey);
      if (lastNotifiedAt !== undefined && now - lastNotifiedAt < CATEGORY_COOLDOWN_MS) continue;

      const deviceStaticPublicKey = this.options.getDeviceStaticPublicKey(registration.deviceId);
      if (!deviceStaticPublicKey) continue;

      const plaintext: PushEnvelopePlaintext = {
        category,
        projectId: taskContext.projectId,
        taskId: taskContext.taskId,
        sessionId,
        taskTitle: taskContext.taskTitle,
        detail,
        sentAt: now,
      };
      let sealedBlob: string;
      try {
        sealedBlob = this.sealEnvelope(hexToBytes(registration.pushKeyHex), deviceStaticPublicKey, plaintext);
      } catch {
        continue; // a malformed stored key must not take down the other devices' sends
      }
      this.cooldowns.set(cooldownKey, now);
      void this.deliver(registration.deviceId, registration.expoPushToken, category, sealedBlob);
    }
  }

  private async deliver(deviceId: string, expoPushToken: string, category: PushCategory, sealedBlob: string): Promise<void> {
    try {
      const result = await sendExpoPush(this.fetchImpl, {
        to: expoPushToken,
        channelId: CHANNEL_IDS[category],
        title: NOTIFICATION_TITLE,
        body: PLACEHOLDER_BODIES[category],
        dataBlob: sealedBlob,
      });
      if (!result.delivered && result.reason === 'device-not-registered') {
        this.options.registrationStore.remove(deviceId);
      }
    } catch {
      // Best-effort: a failed send never propagates into the session pipeline.
    }
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners and clears every pending debounce timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.sessionManager.off('activity', this.onActivity);
      this.options.sessionManager.off('exit', this.onExit);
    }
    for (const debounceTimer of this.permissionDebounceTimers.values()) clearTimeout(debounceTimer);
    this.permissionDebounceTimers.clear();
    this.lastActivityState.clear();
    this.cooldowns.clear();
  }
}
