import { readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SymbiAvatar } from '../src/SymbiAvatarArt';

const file = new URL('../brand/symbi-avatar-demo.html', import.meta.url);
const start = '    // <generated-avatar-markup>';
const end = '    // </generated-avatar-markup>';
const source = await readFile(file, 'utf8');
const hosts = [...source.matchAll(/<[^>]*data-avatar-host="(large|medium|small)"[^>]*>/g)];
if (hosts.length < 3) throw new Error('Avatar preview hosts are missing.');

const markup = hosts.map((host, index) => renderToStaticMarkup(
  createElement(SymbiAvatar, { size: host[1] as 'large' | 'medium' | 'small', state: 'idle', decorative: !host[0].includes('avatar--hero') }),
  { identifierPrefix: `symbi-preview-${index}-` },
));
const generated = `${start}\n    const avatarMarkup = ${JSON.stringify(markup)};\n${end}`;
const from = source.indexOf(start);
const to = source.indexOf(end, from);
if (from < 0 || to < 0) throw new Error('Avatar preview markers are missing.');
const next = source.slice(0, from) + generated + source.slice(to + end.length);
if (next !== source) await writeFile(file, next);
