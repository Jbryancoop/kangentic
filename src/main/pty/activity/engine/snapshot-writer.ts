import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActivityStatsSnapshot } from '../../../../shared/types';

/**
 * Writes activity-engine snapshots to disk for post-mortem
 * diagnostics. Each session gets one JSON file at
 * `<dumpDir>/<sessionId>.json`, atomically rewritten on every state
 * change. Files survive session end so a developer can diagnose
 * "what was the engine doing when X happened" without needing the
 * live overlay open.
 *
 * Lightweight: a snapshot is ~2-4KB serialized. Per-session writes
 * fire only when state changes (not on a polling timer), so an idle
 * session generates no I/O.
 *
 * Atomicity: writes go to `<sessionId>.json.tmp` first, then rename
 * over the target. Partial reads of the JSON file by another tool
 * will never see a half-written document.
 */
export class ActivitySnapshotWriter {
  private readonly dumpDir: string;
  private dirReady = false;

  constructor(dumpDir: string) {
    this.dumpDir = dumpDir;
  }

  write(sessionId: string, snapshot: ActivityStatsSnapshot): void {
    if (!this.ensureDir()) return;
    const filePath = path.join(this.dumpDir, `${sessionId}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // Best-effort. Disk full, permission error, locked file - we
      // don't want a debug-only feature to crash the agent.
    }
  }

  remove(sessionId: string): void {
    if (!this.dirReady) return;
    try {
      fs.unlinkSync(path.join(this.dumpDir, `${sessionId}.json`));
    } catch {
      // Best-effort.
    }
  }

  private ensureDir(): boolean {
    if (this.dirReady) return true;
    try {
      fs.mkdirSync(this.dumpDir, { recursive: true });
      this.dirReady = true;
      return true;
    } catch {
      return false;
    }
  }
}
