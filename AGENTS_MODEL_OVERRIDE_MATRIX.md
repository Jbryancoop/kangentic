# Agent CLI Model/Effort Override Capability Matrix

## Research Summary

**Empirical Testing Method:** CLI `--help` parsing + Context7 documentation deep dive

**Key Finding:** Initial probe script results were incomplete. Context7 documentation reveals **significantly more capability** across all agents.

---

## Capability Matrix

| Agent | `--model` Flag | Live Swap (`/model`) | `--effort` / `--reasoning` Flag | Config File Override | Notes |
|-------|---|---|---|---|---|
| **Claude** | ✅ Yes | ✅ Yes | ✅ `--effort` (low/medium/high/xhigh/max) | N/A | Full feature parity |
| **Cursor** | ✅ Yes | ✅ Yes (`/model`) | ❌ No (reasoning via model name) | `~/.cursor/cli-config.json` | Reasoning models: `sonnet-4.5-thinking`, `gpt-5.2` |
| **Codex** | ✅ Yes (`-m`) | ❌ Unknown | ❌ No flag (config only) | ✅ `config.toml`: `model_reasoning_effort` | Reasoning effort only in config file, NOT CLI |
| **Gemini** | ✅ Yes (`-m`) | ✅ Yes (`/model`) | ❌ No | ✅ `settings.json` | Aliases: `pro`, `flash`, `flash-lite`, `auto` |
| **Copilot** | ✅ Yes | ✅ Yes (`/model`) | ✅ `--reasoning-effort` / `--effort` | N/A | Full effort support like Claude! |
| **OpenCode** | ✅ Yes (`-m`) | ❌ No | ❌ No | ✅ `opencode.json`: per-mode overrides | Format: `provider/model` (e.g., `anthropic/claude-sonnet`) |
| **Qwen Code** | ✅ Yes (`-m`) | ✅ Yes (`/model`) | ❌ No | ✅ `settings.json` | Live interactive picker via `/model` |
| **Kimi Code** | ❓ Unknown* | ❓ Unknown* | ❌ No | ✅ Likely | Research quota exceeded |
| **Droid** | ❓ Unknown* | ❓ Unknown* | ❌ No | N/A | TUI-first design; research quota exceeded |

*Research quota exhausted for Kimi and Droid

---

## Implementation Feasibility by Agent

### 🟢 TIER 1 - High Priority (Complete CLI support)

#### **Cursor** ⭐⭐⭐
- **Model override:** ✅ `--model <model>` flag
- **Live swap:** ✅ `/model` slash command
- **Effort override:** Partial (reasoning via model name, not separate flag)
- **Effort: Via model naming convention** (e.g., `sonnet-4-thinking`, `gpt-5-thinking`)
- **Implementation path:** 
  1. Parse `agent --model` support
  2. Discover available models from session history or `agent about --format json`
  3. Emit `--model` flags in spawn
  4. Implement `/model` verifier if NDJSON stream shows model changes
  5. Create capability discovery for model list

#### **GitHub Copilot CLI** ⭐⭐⭐
- **Model override:** ✅ `--model` flag
- **Effort override:** ✅ `--reasoning-effort` / `--effort` flag (same as Claude!)
- **Live swap:** ✅ `/model` slash command with inline effort adjustment (arrow keys)
- **Implementation path:**
  1. Very similar to Claude (essentially feature parity)
  2. Parse `gh copilot --help` for flags
  3. Model/effort discovery from session history
  4. `/model` verifier for live swap

#### **Claude Code** ✅
- Already implemented

---

### 🟡 TIER 2 - Medium Priority (Partial CLI support, config fallback)

#### **Codex**
- **Model override:** ✅ `-m` / `--model` flag
- **Effort override:** ⚠️ **Config file only** (`config.toml`: `model_reasoning_effort`)
- **No live `/model` slash command**
- **Implementation path:**
  1. Emit `--model` flags (they ARE supported despite probe showing otherwise)
  2. Effort changes require respawn only (read from config, not CLI)
  3. Fall back to respawn when effort changes (Phase 0 fallback handles this)
  4. Discover models from `~/.codex/sessions/*/rollout-*.jsonl`

#### **Gemini CLI**
- **Model override:** ✅ `-m` / `--model` flag
- **Effort override:** ❌ None
- **Live swap:** ✅ `/model` slash command (but no effort control)
- **Implementation path:**
  1. Emit `--model` flags
  2. Implement `/model` verifier for live swap
  3. Discover models from `~/.gemini/tmp/*/chats/session-*.json`
  4. No effort support (effort_override column will be ignored)

#### **OpenCode**
- **Model override:** ✅ `-m` / `--model` flag (format: `provider/model`)
- **Effort override:** ❌ None (Plan/Build agents manage autonomy, not effort)
- **Live swap:** ❌ No slash command (respawn-only)
- **Per-mode override:** ✅ Can set `agent.plan.model`, `agent.build.model` in config
- **Implementation path:**
  1. Emit `--model provider/model` flags
  2. Discover available models from provider config
  3. Respawn fallback (Phase 0) for model changes
  4. Note: User preference says "CLI features over custom layers" - let TUI picker handle it?

#### **Qwen Code**
- **Model override:** ✅ `-m` / `--model` flag
- **Effort override:** ❌ None
- **Live swap:** ✅ `/model` slash command (interactive picker)
- **Config:** ✅ `settings.json` with `modelProviders`
- **Implementation path:**
  1. Emit `--model` flags
  2. Implement `/model` verifier for live swap
  3. Discover models from `~/.qwen/projects/*/chats/*.jsonl` or config
  4. No effort support

---

### 🔴 TIER 3 - Lower Priority (TUI-first design, limited CLI support)

#### **Kimi Code**
- **Model override:** ❓ Likely has `--model` flag (similar to Qwen/Gemini)
- **Effort override:** ❌ None
- **Research:** Quota exhausted - need empirical testing
- **Known:** Has config file, TUI-first interface

#### **Droid**
- **Model override:** ❓ Unknown (TUI-first design)
- **Effort override:** ❌ None (uses autonomy levels, not effort)
- **Research:** Quota exhausted
- **Known from code:** Intentionally omits `--settings` file injection (user prefers TUI control)
- **User preference:** "TUI already exposes everything... don't shadow it"

---

## Summary Table: Implementation Readiness

| Agent | CLI Flags | Live Swap | Effort | Config | Effort Strategy | Priority |
|-------|---|---|---|---|---|---|
| Claude | ✅ Full | ✅ Yes | ✅ Full | N/A | CLI flags | Done ✅ |
| **Cursor** | ✅ Model | ✅ Yes | ⚠️ Model name | Config | Via model ID | 1️⃣ |
| **Copilot** | ✅ Full | ✅ Yes | ✅ Full | N/A | CLI flags | 1️⃣ |
| Codex | ✅ Model | ❌ No | ⚠️ Config | Config | Config file | 2️⃣ |
| Gemini | ✅ Model | ✅ Yes | ❌ None | Config | N/A | 2️⃣ |
| OpenCode | ✅ Model | ❌ No | ❌ None | Config | Per-mode config | 2️⃣ |
| Qwen | ✅ Model | ✅ Yes | ❌ None | Config | N/A | 2️⃣ |
| Kimi | ❓ Model | ❓ Unknown | ❌ None | Config | Need testing | 3️⃣ |
| Droid | ❓ Unknown | ❓ Unknown | ❌ None | N/A | TUI-only | 3️⃣ |

---

## Recommended Implementation Order

### Phase 1: Tier 1 (CLI-native, full/near-full support)
1. **Cursor** (user very interested, `--model` + `/model` support)
2. **Copilot** (feature parity with Claude: `--model` + `--effort` + `/model`)
3. *(Claude already done)*

### Phase 2: Tier 2 (CLI + config hybrid)
4. **Codex** (has `--model` but effort config-only; respawn fallback needed)
5. **Gemini** (has `--model` + `/model` live swap, no effort)
6. **OpenCode** (has `--model`, no live swap; respawn fallback)
7. **Qwen** (has `--model` + `/model`, no effort)

### Phase 3: Tier 3 (research + user input needed)
8. **Kimi** (need empirical testing for flags + live swap)
9. **Droid** (TUI-first; confirm design intent with user before implementing)

---

## Critical Unknowns (Need User Input or Empirical Testing)

1. **Kimi Code:**
   - Does it have `--model` flag?
   - Does it support `/model` slash command for live swap?
   - Where are session transcripts stored?

2. **Droid:**
   - Does it support any `--model` CLI flag?
   - Is TUI-only model selection the intended design?
   - Should Kangentic NOT add per-column overrides to preserve user's TUI control?

3. **Codex Reasoning Effort:**
   - Can Kangentic rewrite `config.toml` to apply `model_reasoning_effort` dynamically?
   - Or should effort changes always trigger respawn (apply on next spawn)?

4. **Effort Level Naming Across Agents:**
   - Claude: `low, medium, high, xhigh, max`
   - Copilot: `high` (mentioned in docs; what others exist?)
   - Others: No documented effort levels

---

## Effort Estimation

| Agent | Probe/Test | Discovery | Command-Builder | Live Verifier | Tests | Total |
|-------|---|---|---|---|---|---|
| Cursor | 30m | 1.5h | 30m | 1.5h | 1h | ~5h |
| Copilot | 30m | 1.5h | 30m | 1.5h | 1h | ~5h |
| Codex | 30m | 1h | 30m | n/a* | 1h | ~3.5h |
| Gemini | 30m | 1h | 30m | 1h | 1h | ~4h |
| OpenCode | 30m | 1h | 30m | n/a* | 1h | ~3.5h |
| Qwen | 30m | 1h | 30m | 1h | 1h | ~4h |
| Kimi | 1h+ | 1.5h | 30m | ? | 1h | ~5h+ |
| Droid | (research needed) | ? | ? | ? | ? | ? |

*Respawn-only (no live verifier needed)

---

## Design Decisions Needed

1. **Cursor as Priority 1?** (User is very interested + best CLI support)
2. **Copilot as Priority 1?** (Feature parity with Claude: `--effort` support)
3. **Droid design intent?** (TUI-only vs. CLI flag support?)
4. **Config-file rewrites for Codex?** (Dynamic `config.toml` updates or respawn-only?)
5. **How to handle agents without effort support?** (Hide dropdown vs. greyed out?)
