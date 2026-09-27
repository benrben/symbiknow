export function fileNameForTitle(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base) throw new Error('A document title must contain a letter or number.');
  return `${base}.md`;
}
