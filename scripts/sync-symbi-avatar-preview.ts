import { readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantAvatar } from '../src/AssistantAvatar';
import { avatarPoses, type AvatarSize } from '../src/avatar-types';

const file = new URL('../brand/symbi-avatar-demo.html', import.meta.url);
const start = '    // <generated-avatar-markup>';
const end = '    // </generated-avatar-markup>';
const source = await readFile(file, 'utf8');
const hosts = [...source.matchAll(/<[^>]*data-avatar-host="(large|medium|small)"[^>]*>/g)];
if (hosts.length < 3) throw new Error('Avatar preview hosts are missing.');

const previewStates = [...avatarPoses, 'paused', 'cancelled', 'error', 'unavailable'] as const;
const avatarMarkup = hosts.map(host => Object.fromEntries(previewStates.map(state => [state,
  renderToStaticMarkup(createElement(AssistantAvatar, {
    name: host[0].includes('data-assistant="Symbi Reflex"') ? 'Symbi Reflex' : 'Symbi',
    size: host[1] as AvatarSize, state, decorative: !host[0].includes('avatar--hero'),
  })),
])));
const generated = `${start}\n    const poses = ${JSON.stringify(avatarPoses)};\n    const avatarMarkup = ${JSON.stringify(avatarMarkup)};\n${end}`;
const from = source.indexOf(start);
const to = source.indexOf(end, from);
if (from < 0 || to < 0) throw new Error('Avatar preview markers are missing.');
const next = source.slice(0, from) + generated + source.slice(to + end.length);
if (next !== source) await writeFile(file, next);
