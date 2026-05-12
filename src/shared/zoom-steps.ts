// Chrome-compatible zoom step ladder used by the embedded browser pane.
//
// Used in two places:
//   - Renderer (BrowserPane): Ctrl+/-/0 keyboard shortcuts snap to a rung.
//   - Main (zoom-changed handler): Ctrl+wheel inside the webview uses a
//     smooth multiplicative step (WHEEL_ZOOM_FACTOR) clamped to MIN/MAX.

export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0,
  2.5, 3.0, 4.0, 5.0,
];

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5.0;

/**
 * Return the next zoom level in `direction` (+1 = in, -1 = out) starting
 * from `current`.
 *
 * Algorithm:
 *   1. Find the rung on ZOOM_STEPS closest to `current` by absolute distance.
 *   2. Move one step in `direction`.
 *   3. Clamp to [0, ZOOM_STEPS.length - 1] so the boundaries are idempotent.
 *
 * When `current` sits exactly on a rung, "nearest" is that rung. When it
 * sits between rungs (e.g. Ctrl+wheel left the factor at 1.07), "nearest"
 * is the closer of the two surrounding rungs - zooming in from 1.07 will
 * therefore snap first to 1.1, not skip ahead to 1.25.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  let nearestIndex = 0;
  for (let index = 1; index < ZOOM_STEPS.length; index += 1) {
    if (
      Math.abs(ZOOM_STEPS[index] - current) <
      Math.abs(ZOOM_STEPS[nearestIndex] - current)
    ) {
      nearestIndex = index;
    }
  }
  const targetIndex = Math.max(
    0,
    Math.min(ZOOM_STEPS.length - 1, nearestIndex + direction),
  );
  return ZOOM_STEPS[targetIndex];
}
