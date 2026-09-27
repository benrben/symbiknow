import { describe, expect, it } from 'vitest';
import { detectLoader, loaderFor, uploadedSource } from './file-transfer.js';

describe('detectLoader', () => {
  it('uses HTML frontmatter before all other format hints', () => {
    expect(detectLoader('---\nmarp: true\nformat: html\ngenerator: hugo\nsource: docs\n---\n# Page')).toEqual({ kind: 'markdown', confidence: 1 });
  });

  it('recognizes generated websites only when they declare a source', () => {
    expect(detectLoader('---\ngenerator: MkDocs\nsource: docs/\n---\n# Home')).toEqual({ kind: 'website', confidence: 1 });
    expect(detectLoader('---\ngenerator: docusaurus\n---\n# Home')).toEqual({ kind: 'markdown', confidence: 1 });
    expect(detectLoader('---\ngenerator: hugo\nsource: ""\n---\n# Home')).toEqual({ kind: 'markdown', confidence: 1 });
  });

  it('detects Marp and multiple slide breaks without asking Jev', () => {
    expect(detectLoader('---\nmarp: true\n---\n# One\n---\n# Two')).toEqual({ kind: 'slides', confidence: 1 });
    expect(detectLoader('# One\n---\n# Two\n---\n# Three')).toEqual({ kind: 'slides', confidence: 1 });
    expect(detectLoader('# One\r\n---\r\n# Two\r\n---\r\n# Three')).toEqual({ kind: 'slides', confidence: 1 });
  });

  it('asks Jev for exactly one body slide break, excluding frontmatter and fenced code', () => {
    expect(detectLoader('---\ntitle: Deck\n---\n# One\n---\n# Two')).toEqual({ fallback: true });
    expect(detectLoader('---\ntitle: Note\n---\n# One')).toEqual({ kind: 'markdown', confidence: 1 });
    expect(detectLoader('---\n---\n# One\n---\n# Two')).toEqual({ fallback: true });
    expect(detectLoader('# Note\n```md\n---\n---\n```')).toEqual({ kind: 'markdown', confidence: 1 });
  });

  it('recognizes MDX component blocks and exports outside code fences', () => {
    expect(detectLoader('# Widget\n<Chart data={points} />')).toEqual({ kind: 'mdx', confidence: 1 });
    expect(detectLoader('export const metadata = { title: "Demo" };')).toEqual({ kind: 'mdx', confidence: 1 });
    expect(detectLoader('~~~tsx\n<Chart />\nexport const example = true\n~~~')).toEqual({ kind: 'markdown', confidence: 1 });
  });

  it('asks Jev about capitalized tags embedded in prose', () => {
    expect(detectLoader('This paragraph mentions <Widget /> in passing.')).toEqual({ fallback: true });
    expect(detectLoader('Use <div> for a plain HTML example.')).toEqual({ kind: 'markdown', confidence: 1 });
    expect(detectLoader('# Deck\n---\n<Chart />')).toEqual({ kind: 'mdx', confidence: 1 });
  });

  it('prioritizes slide structure over MDX syntax', () => {
    expect(detectLoader('# One\n---\n<Chart />\n---\n# Three')).toEqual({ kind: 'slides', confidence: 1 });
  });
});

describe('existing file transfer helpers', () => {
  it('keeps uploaded HTML on the markdown loader', () => {
    const uploaded = uploadedSource('page.html', '<h1>Hi</h1>');
    expect(uploaded.kind).toBe('markdown');
    expect(loaderFor('slides', uploaded.content)).toBe('markdown');
  });
});
