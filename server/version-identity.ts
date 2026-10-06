export function commitIdentity(author: string): { name: string; email: string } {
  const name = author.replace(/[<>\n]/g, '').slice(0, 48) || 'SymbiKnow';
  // A nonempty name stays nonempty: every unsupported run becomes one hyphen.
  const email = `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}@symbiknow.local`;
  return { name, email };
}

export function mergeEmail(author: string): string {
  return `${author.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'symbiknow'}@symbiknow.local`;
}
