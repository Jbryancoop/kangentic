import path from 'node:path';
import { isKangenticHookCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';

/**
 * Shape of an entry in the legacy project-local `.codex/hooks.json` array.
 * Retained only for cleanup of files written by older Kangentic builds.
 */
interface CodexLegacyHookEntry {
  event: string;
  command: string;
  timeout_secs?: number;
}

/** Path to .codex/hooks.json for a given project directory. */
function codexHooksPath(directory: string): string {
  return path.join(directory, '.codex', 'hooks.json');
}

/**
 * Codex 0.128 redesigned the hook system. User hooks now live in
 * `~/.codex/config.toml` under `[[hooks]]` tables (TOML, snake_case event
 * names like `pre_tool_use`, camelCase fields `eventName`/`timeoutSec`), or
 * inside a Codex plugin folder referenced from a `plugin.json` manifest.
 *
 * The legacy project-local `.codex/hooks.json` (top-level JSON array) is no
 * longer recognized. Codex 0.128 surfaces a yellow `failed to parse hooks
 * config ... trailing characters` warning at startup whenever it finds one.
 *
 * Older Kangentic builds wrote that file as forward-compat for a hook pipeline
 * that 0.118 also ignored in practice, so removing the writer reverts to
 * the same effective behavior we already had on 0.118 with no functional loss.
 *
 * `buildHooks` is invoked from the spawn path; we use it to clean up any stale
 * Kangentic-owned entries left over from a pre-upgrade Kangentic install. We
 * never write the file ourselves any more.
 *
 * Re-enabling Codex hook integration via the new TOML/plugin format is a
 * separate effort tracked by the task this fix originated from.
 */
export function buildHooks(projectRoot: string): void {
  cleanupLegacyHooks(projectRoot);
}

/**
 * Strip ALL Kangentic hook entries from a legacy `.codex/hooks.json` at the
 * given directory. Preserves any user-defined hooks; deletes the file if
 * only Kangentic-owned entries remained.
 */
export function removeHooks(directory: string): void {
  cleanupLegacyHooks(directory);
}

function cleanupLegacyHooks(directory: string): void {
  safelyUpdateSettingsFile(codexHooksPath(directory), (parsed) => {
    if (!Array.isArray(parsed)) return null;
    const hooks = parsed as CodexLegacyHookEntry[];
    const filtered = hooks.filter(entry => !isKangenticHookCommand(entry.command));
    return filtered.length === hooks.length ? null : filtered;
  }, 'cleanupLegacyHooks');
}
