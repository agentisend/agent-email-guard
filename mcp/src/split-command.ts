/** Split a `--wrap` command on whitespace, keeping quoted segments together. */
export function splitCommand(input: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error('The --wrap command has an unclosed quote.');
  if (current.length > 0) parts.push(current);
  const command = parts[0];
  if (command === undefined) throw new Error('--wrap needs a command.');
  return { command, args: parts.slice(1) };
}
