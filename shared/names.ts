export function fileNameForTitle(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base) throw new Error('A document title must contain a letter or number.');
  return `${base}.md`;
}

const boldFieldLabel = /^(\*\*|__)[^*_]{1,32}:\1\s*/;
const snakeIdentifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function stripInlineMarkdown(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/, '').replace(/[*`~]+/g, '')
    .replace(/(^|\s)_{1,2}(\S(?:.*?\S)?)_{1,2}(?=\s|$)/g, '$1$2').replace(/\s+/g, ' ').trim();
}

function humanizeIdentifier(text: string): string {
  if (!snakeIdentifier.test(text)) return text;
  const words = text.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Group names come from document captions and headings; show the words a reader sees, not Markdown source. */
export function plainGroupName(name: string): string {
  const plain = humanizeIdentifier(stripInlineMarkdown(name.trim().replace(boldFieldLabel, '')));
  return plain || name.trim();
}
