/**
 * Deterministic per-project accent color for the phone's board and
 * triage views. The desktop has no user-set project color today, so the
 * accent is derived by hashing the project id onto a curated palette:
 * stable across restarts and across devices (both sides of a pairing
 * see the same color) without storing anything. When a real user-set
 * project color lands, it overrides this derivation and flows through
 * the exact same wire fields (ReadBoardProjectSummary.color /
 * ReadBoardSnapshotResponsePayload.projectColor) with no phone change.
 *
 * The palette is 12 mid-saturation tones chosen to read well as accents
 * on a near-black background (the phone renders a terminal-dark theme):
 * ambers through greens, teals, blues, purples, and roses, spread
 * around the hue wheel so neighboring projects rarely collide.
 */
export const PROJECT_ACCENT_PALETTE = [
  '#fbbf24', // amber
  '#fb923c', // orange
  '#fb7185', // rose
  '#f472b6', // pink
  '#c084fc', // purple
  '#a78bfa', // violet
  '#60a5fa', // blue
  '#38bdf8', // sky
  '#2dd4bf', // teal
  '#34d399', // emerald
  '#4ade80', // green
  '#a3e635', // lime
] as const;

/** FNV-1a 32-bit over the project id, mapped onto the palette. Pure and deterministic. */
export function deriveProjectAccentColor(projectId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index++) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return PROJECT_ACCENT_PALETTE[(hash >>> 0) % PROJECT_ACCENT_PALETTE.length];
}
