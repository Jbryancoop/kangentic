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

// <task><title>...</title><description>...</description></task>
// Self-closes <description> when empty so the envelope stays tidy.
export function buildTaskXml(input: TaskXmlInput): string {
  const lines: string[] = ['<task>'];
  lines.push(`  <title>${escapeXml(input.title)}</title>`);
  if (input.description.trim()) {
    lines.push(`  <description>${escapeXml(input.description)}</description>`);
  } else {
    lines.push('  <description />');
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
