import * as path from 'node:path';
import * as os from 'node:os';
import { collectRelocationPairs, renameOrMergeDirectory } from '../../shared/relocation-utils';
import { cwdToSessionSlug } from './session-id-capture';

/**
 * Migrate Droid's per-project session data when a Kangentic project is relocated.
 *
 * Droid keys its sessions to the absolute cwd, OUTSIDE the project folder:
 *   `~/.factory/sessions/<cwd-slug>/<uuid>.jsonl` (+ `<uuid>.settings.json`)
 * where the slug replaces `:`, `\`, and `/` runs with a single `-` and ensures
 * a leading dash (see `cwdToSessionSlug`, verified against Droid 0.109.1).
 *
 * Droid is closed source, so the exact resume-resolution semantics around this
 * directory are not authoritatively documented; renaming the slug directory is
 * the best-effort migration that keeps Kangentic's own session-file locator
 * (and Droid's cwd-scoped session list) pointed at the moved data. There is no
 * out-of-project config file to rewrite.
 *
 * Best-effort and non-destructive: directories are renamed or merged, never
 * deleted, and each pair is guarded so a partial failure never blocks relocation.
 */
export async function migrateDroidProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  const sessionsRoot = path.join(os.homedir(), '.factory', 'sessions');

  for (const pair of collectRelocationPairs(oldProjectPath, newProjectPath)) {
    try {
      renameOrMergeDirectory(
        path.join(sessionsRoot, cwdToSessionSlug(pair.oldAbsolute)),
        path.join(sessionsRoot, cwdToSessionSlug(pair.newAbsolute)),
      );
    } catch (err) {
      console.warn(`[DROID_RELOCATE] Failed to migrate sessions for ${pair.oldAbsolute}:`, err);
    }
  }
}
