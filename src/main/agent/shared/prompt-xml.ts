// Anthropic + OpenAI canonical guidance: wrap prompt input data in XML tags
// so the model sees a clear data/instruction boundary. Non-XML-aware agents
// (Aider, Codex) treat the markup as harmless prose; the structured fields
// stay readable. Source: Anthropic prompt-engineering courses, OpenAI docs.

// Escapes both quote styles so values are safe inside `"..."` and `'...'`
// attribute values. Anthropic's prompt-engineering guidance lists `'` as one
// of the entities to escape; keeping both also protects future attribute
// emitters that pick the other quote style.
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TaskXmlInput {
  title: string;
  description: string;
}

// Single-line description:
//   <task>
//     <title>...</title>
//     <description>short text</description>
//   </task>
//
// Multi-line description (open and close on their own lines so the close
// tag visually pairs with the opener instead of glueing to the last word):
//   <task>
//     <title>...</title>
//     <description>
//   first paragraph
//
//   second paragraph
//   </description>
//   </task>
//
// Multi-line content is NOT indented - that would mutate the description
// body (e.g. silently breaking a markdown code block by adding a 2-space
// prefix that no longer matches the opening fence). The leading and
// trailing newline added around the content are harmless: agents trim
// whitespace inside element bodies.
//
// Empty optional sections are omitted entirely (no `<description />`) so an
// empty tag never gives the agent a "Got it - what would you like me to do?"
// non-signal. When future fields like <labels> or <acceptance_criteria> are
// added, follow the same omit-when-empty pattern.
export function buildTaskXml(input: TaskXmlInput): string {
  const lines: string[] = ['<task>'];
  lines.push(`  <title>${escapeXml(input.title)}</title>`);
  if (input.description.trim()) {
    // Strip trailing whitespace/newlines so the close tag sits on the next
    // line directly after content - never with a stray blank line between.
    const body = input.description.replace(/\s+$/, '');
    if (body.includes('\n')) {
      lines.push('  <description>');
      lines.push(escapeXml(body));
      lines.push('  </description>');
    } else {
      lines.push(`  <description>${escapeXml(body)}</description>`);
    }
  }
  lines.push('</task>');
  return lines.join('\n');
}

export interface HandoffXmlInput {
  sourceDisplayName: string;
  sessionFilePath: string | null;
  targetHasMcpAccess: boolean;
}

// Instruction prose stays at top level (matches the browser_context reference
// implementation in src/main/ipc/handlers/browser-payload.ts) so the user's
// directive is the first thing the model sees. Structured pointers go in the
// <handoff_context> envelope underneath.
export function buildHandoffXml(input: HandoffXmlInput): string {
  const lines: string[] = [];
  lines.push(`You are continuing work on this task that was previously handled by ${input.sourceDisplayName}.`);
  if (input.sessionFilePath) {
    lines.push('Read the prior session history for context on what was done, decisions made, and current state.');
    if (input.targetHasMcpAccess) {
      lines.push('You can also use the `kangentic_get_session_history` MCP tool to read the prior session content directly.');
    }
  } else {
    lines.push('No session history file is available. Check `git log` for prior changes on this branch.');
  }
  lines.push('');
  lines.push('<handoff_context>');
  lines.push(`  <source_agent>${escapeXml(input.sourceDisplayName)}</source_agent>`);
  if (input.sessionFilePath) {
    lines.push(`  <session_history_path>${escapeXml(input.sessionFilePath)}</session_history_path>`);
  } else {
    lines.push('  <session_history_path />');
  }
  lines.push('</handoff_context>');
  return lines.join('\n');
}
