import { Terminal, type ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * Scrollback rows retained by the headless parser and included in a serialized
 * mobile seed frame. The CURRENT on-screen grid is always serialized in full
 * regardless of this value; these rows give the phone a little history above
 * the fold. A few hundred lines is ample for a phone seed and keeps both the
 * retained buffer and the per-serialize cost bounded.
 */
const SERIALIZED_SCROLLBACK_LINES = 500;

/**
 * `@xterm/headless` declares its OWN `ITerminalAddon` (structurally identical
 * to `@xterm/xterm`'s: `activate(terminal)` + `dispose()`), while
 * `SerializeAddon` implements the `@xterm/xterm` one. The two are nominally
 * distinct modules, so `loadAddon` rejects the addon on type identity alone
 * even though it is byte-for-byte compatible at runtime (the serialize addon
 * reads only the core buffer/mode APIs that headless also exposes). This is the
 * single, minimal typed bridge - no `any`, no runtime shim - between them.
 */
type HeadlessTerminalAddon = ITerminalAddon;

/**
 * A per-session HEADLESS xterm parser kept in the MAIN process, fed the same
 * PTY output as the raw scrollback ring. Its serialized frame is a snapshot of
 * the PARSED grid - every currently-visible cell whatever its draw age - which
 * the mobile seed uses instead of a raw 512KB byte replay. A raw replay drops
 * the write-once static cells of a fullscreen TUI (e.g. Claude Code's static
 * status-line segment) once the bytes that drew them age out of the byte
 * window; the parsed grid always carries them.
 *
 * Never call `.open()`: `@xterm/headless` has no DOM and runs the VT parser
 * plus buffer only.
 */
export class HeadlessFrameBuffer {
  private readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
      scrollback: SERIALIZED_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer as unknown as HeadlessTerminalAddon);
  }

  /** Feed a raw PTY chunk into the parser (the same bytes the scrollback ring receives). */
  write(data: string): void {
    this.terminal.write(data);
  }

  /** Resize the parsed grid to match a PTY resize so serialized frames reflow to the new geometry. */
  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  /**
   * Drain the write buffer. xterm parses a normal `write()` asynchronously (it
   * schedules the parse on a macrotask, not synchronously), so serializing
   * right after the last `write()` would snapshot a STALE grid. A zero-length
   * write's callback fires only once every queued chunk ahead of it has been
   * parsed, which is exactly the flush barrier we need.
   */
  private flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.terminal.write('', resolve);
    });
  }

  /**
   * Snapshot the parsed grid as a self-contained escape-sequence frame the
   * phone can cold-replay into a fresh xterm. Flushes pending writes first so
   * the frame reflects every byte fed so far.
   *
   * The serialize addon includes the alt buffer (`excludeAltBuffer` left at its
   * false default) and the active terminal modes (`excludeModes` left false):
   * it emits `\x1b[?1049h` when the session is in the alt screen and re-asserts
   * DECCKM / mouse-tracking / bracketed-paste / focus modes from
   * `terminal.modes`. So the frame carries its own mode/alt-screen preamble -
   * the phone lands in the right screen with the right input modes without any
   * extra prefix, matching what the raw scrollback path prepended by hand.
   */
  async serialize(): Promise<string> {
    await this.flush();
    return this.serializer.serialize({ scrollback: SERIALIZED_SCROLLBACK_LINES });
  }

  dispose(): void {
    this.serializer.dispose();
    this.terminal.dispose();
  }
}
