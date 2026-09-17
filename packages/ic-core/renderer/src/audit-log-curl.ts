import type { AuditLogEntry } from '../../electron/shared/ipcContracts';

/**
 * §7's audit log (phase 1.22) "Copy as cURL" action — built entirely from an `AuditLogEntry`,
 * which only ever holds the already-redacted form (`sanitizeHeadersForLog`/`sanitizeBodyForLog`/
 * `sanitizeResponseBodyForLog`, computed in `http-client.ts` before the entry is ever persisted).
 * There is deliberately no "unredacted" variant of this — the real values were never stored
 * anywhere to begin with, so there's nothing left to reveal; a redacted header/body shows up here
 * as the literal `[REDACTED]` placeholder, safe to paste into a support ticket or chat as-is.
 */
function shellEscapeSingleQuoted(value: string): string {
  // POSIX single-quoting: end the quote, emit an escaped literal quote, reopen — the standard
  // way to embed a literal `'` inside a single-quoted shell argument.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCurlCommand(entry: AuditLogEntry): string {
  const lines = [`curl -X ${entry.method} \\`];

  for (const [name, value] of Object.entries(entry.requestHeaders)) {
    lines.push(`  -H ${shellEscapeSingleQuoted(`${name}: ${value}`)} \\`);
  }

  if (entry.requestBody.kind === 'json') {
    lines.push(`  -d ${shellEscapeSingleQuoted(JSON.stringify(entry.requestBody.value))} \\`);
  } else if (entry.requestBody.kind === 'text') {
    lines.push(`  -d ${shellEscapeSingleQuoted(entry.requestBody.value)} \\`);
  } else if (entry.requestBody.reason !== 'empty') {
    lines.push(`  # request body omitted (${entry.requestBody.reason}) \\`);
  }

  lines.push(`  ${shellEscapeSingleQuoted(entry.url)}`);
  return lines.join('\n');
}
