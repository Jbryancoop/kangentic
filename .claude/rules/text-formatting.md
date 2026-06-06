# Rule: no em-dashes or double-dashes as punctuation

Em-dashes (U+2014) render as garbled characters on Windows console code pages, and the team
ships and dogfoods on Windows. Double-dashes (`--`) used as separators look awkward in UI text
and terminal output. Authored punctuation must use a single dash or be restructured.

## The rule

Never use an em-dash (U+2014, the long dash), `&mdash;`, or `--` as a sentence or list
separator in anything you author: source code, comments, tests, docs, scripts, JSX, commit
messages, and user-facing chat.

- Use a single dash for inline separators, e.g. `**Bold** - description`.
- Or restructure the sentence with a period.

This forbids em-dashes you write. It does not forbid em-dashes that appear inside recorded
data (captured terminal scrollback, replay fixtures, assertions that mirror real agent
output), where the character is content, not punctuation you chose.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/no-em-dashes.test.ts` scans `src/` and `scripts/` and fails on any
  U+2014. Runs in CI via `npm run test:unit`. This covers authored production and build code.
- **Review:** the `platform-guard` agent flags em-dashes anywhere during `/code-review`,
  including `tests/`, `docs/`, and markdown, which the mechanical test deliberately does not
  scan.

Mechanical coverage of `tests/` and `docs/` is intentionally left to review: those trees
contain captured data, and widening the test would require distinguishing authored text from
recorded content, which a static scan cannot do.

## Scope

Punctuation you author, in any file type. Recorded or captured content is exempt. There is no
allowlist in the source trees the test scans (`src/`, `scripts/`); keep them clean.
