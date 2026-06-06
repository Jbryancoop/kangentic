#!/usr/bin/env node
/**
 * Event Bridge - Generic hook-to-JSONL bridge for all agent adapters.
 *
 * Agent CLIs invoke this script via hooks. Appends a single JSON line
 * to the events log. All agent-specific knowledge (field names, event
 * types, stdin formats) is passed via command-line directives from each
 * adapter's hook-manager.
 *
 * Usage:
 *   node event-bridge.js <events-file-path> <event-type> [directives...]
 *
 * Directives are produced by the typed builders in
 * src/main/agent/shared/directive-builders.ts and have the wire form
 * `<kind>:<base64(JSON(payload))>`. The CLI runs the hook command in SHELL
 * form (the whole command string is tokenized on whitespace), so encoding the
 * payload as base64 keeps every directive a single shell token regardless of
 * the values it carries (spaces, quotes, ':' , unicode). Never hand-author the
 * wire string - use the builders.
 *
 *   extractTool                { field }             -> event.tool = ctx[field]
 *   extractToolId              { fields[], nested? } -> event.toolId = first non-null
 *   extractDetail              { fields[], nested? } -> event.detail = first non-null
 *   setDetail                  { value }            -> event.detail = value
 *   setTypeWhen                { whenTool?, nested?:[p,f], field?, equals, to }
 *                                 -> if (no whenTool or ctx.tool_name===whenTool) AND
 *                                    String(addressed field's value) === equals, event.type = to
 *   setTypeWhenDetailContains  { contains, to }     -> if event.detail (already
 *                                 extracted) contains `contains` (case-insensitive),
 *                                 event.type = to. Must be listed AFTER an extractDetail.
 *
 * Stdin: Agent CLIs pipe hook context as JSON. Directives control which
 * fields are extracted for each event type.
 */
// Stdout guard: Gemini CLI rejects any stdout output from hook scripts as
// malformed JSON (docs: "Strict JSON" rule). Codex/Claude tolerate noise on
// stdout but it still gets logged as hook output. We explicitly suppress
// stdout so a stray console.log added during debugging can never silently
// break hook parsing. All diagnostics must go to stderr.
process.stdout.write = () => true;

const fs = require('fs');
const outputPath = process.argv[2];
const eventType = process.argv[3] || 'idle';
const directives = process.argv.slice(4);

/**
 * Append a diagnostic line to the sibling error log so silent pipeline
 * failures (unknown/malformed directive, file locked, disk full) are
 * discoverable instead of vanishing. Best-effort: the error log may also fail.
 */
function logBridgeError(message) {
  if (!outputPath) return;
  try {
    const errorPath = outputPath.replace(/events\.jsonl$/, 'events-bridge.error.log');
    fs.appendFileSync(errorPath, `${new Date().toISOString()} ${eventType} ${message}\n`);
  } catch {
    // Truly nothing we can do
  }
}

/** Decode a `<kind>:<base64(JSON)>` directive. payload is undefined if malformed. */
function decodeDirective(directive) {
  const colonIndex = directive.indexOf(':');
  if (colonIndex <= 0) return { kind: directive, payload: undefined };
  const kind = directive.slice(0, colonIndex);
  try {
    const json = Buffer.from(directive.slice(colonIndex + 1), 'base64').toString('utf8');
    return { kind, payload: JSON.parse(json) };
  } catch {
    return { kind, payload: undefined };
  }
}

/** First non-null value of `fields` in `container`, stringified and capped. */
function firstNonNull(container, fields) {
  if (!container || typeof container !== 'object' || !Array.isArray(fields)) return undefined;
  for (const field of fields) {
    const value = container[field];
    if (value != null) return String(value).slice(0, 200);
  }
  return undefined;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!outputPath) return;

  const event = { ts: Date.now(), type: eventType };

  // Parse stdin JSON once for all directives
  let ctx = null;
  if (input && input.length > 0) {
    try { ctx = JSON.parse(input); } catch { /* stdin not valid JSON */ }
  }

  // Process directives in list order (setTypeWhenDetailContains relies on a
  // prior extractDetail directive having run).
  for (const directive of directives) {
    const { kind, payload } = decodeDirective(directive);
    // Every directive payload is a JSON object. Reject undefined (malformed
    // base64/JSON) AND any non-object (e.g. a literal `null`, which JSON.parse
    // accepts) so a switch case can never dereference a non-object and crash
    // the process before the event is written - it stays a logged no-op.
    if (payload === null || typeof payload !== 'object') {
      logBridgeError(`malformed directive: ${directive}`);
      continue;
    }

    switch (kind) {
      case 'extractTool': {
        if (ctx && payload.field && ctx[payload.field] != null) event.tool = ctx[payload.field];
        break;
      }
      case 'extractToolId': {
        if (event.toolId !== undefined) break;
        const container = payload.nested ? (ctx && ctx[payload.nested]) : ctx;
        const value = firstNonNull(container, payload.fields);
        if (value !== undefined) event.toolId = value;
        break;
      }
      case 'extractDetail': {
        if (event.detail !== undefined) break;
        const container = payload.nested ? (ctx && ctx[payload.nested]) : ctx;
        const value = firstNonNull(container, payload.fields);
        if (value !== undefined) event.detail = value;
        break;
      }
      case 'setDetail': {
        // A fixed value, not an extraction: overwrites any prior detail by design.
        if (payload.value != null) event.detail = String(payload.value).slice(0, 200);
        break;
      }
      case 'setTypeWhen': {
        if (!ctx) break;
        if (payload.whenTool && ctx.tool_name !== payload.whenTool) break;
        const container = payload.nested ? ctx[payload.nested[0]] : ctx;
        const field = payload.nested ? payload.nested[1] : payload.field;
        if (container && typeof container === 'object' && String(container[field]) === payload.equals) {
          event.type = payload.to;
        }
        break;
      }
      case 'setTypeWhenDetailContains': {
        if (payload.to && typeof event.detail === 'string'
            && event.detail.toLowerCase().includes(String(payload.contains).toLowerCase())) {
          event.type = payload.to;
        }
        break;
      }
      default:
        logBridgeError(`unknown directive kind: ${kind}`);
    }
  }

  // Capture the full stdin payload as hookContext on session_start only (so
  // adapters can extract the agent-assigned session id). Skipped for other
  // event types to avoid bloating the JSONL file.
  if (eventType === 'session_start' && ctx && Object.keys(ctx).length > 0) {
    event.hookContext = JSON.stringify(ctx).slice(0, 2048);
  }

  try {
    fs.appendFileSync(outputPath, JSON.stringify(event) + '\n');
  } catch (err) {
    // Don't swallow silently - surface genuine pipeline failures (file
    // locked, path missing, disk full) to the sibling error log.
    logBridgeError(err && err.message ? err.message : String(err));
  }
});
