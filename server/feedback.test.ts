import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { feedbackSummary, jevCalibration, recordFeedback } from './feedback.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-feedback-'));
  dirs.push(dir);
  return dir;
}

async function fill(root: string, canvasId: string, category: string, confidence: number, decision: 'applied' | 'dismissed', count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await recordFeedback(root, canvasId, { itemId: `${category}-${confidence}-${decision}-${index}`, category, confidence, decision });
  }
}

afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Jev calibration', () => {
  it('suggests the lowest confidence bucket meeting the apply-rate and sample-size bar', async () => {
    const root = await tempDir();
    // 19 applied + 1 dismissed at 0.75-0.85 for "connection" (maps to link): 95% apply rate but only 20 decisions exactly.
    await fill(root, 'canvas-a', 'connection', 0.8, 'applied', 19);
    await fill(root, 'canvas-a', 'connection', 0.8, 'dismissed', 1);
    // Lower bucket (0.65-0.75) has plenty of decisions but a poor apply rate, so it must not be picked.
    await fill(root, 'canvas-a', 'connection', 0.7, 'applied', 5);
    await fill(root, 'canvas-a', 'connection', 0.7, 'dismissed', 20);
    const suggestions = await jevCalibration(root);
    const link = suggestions.find(item => item.kind === 'link');
    expect(link).toMatchObject({ suggestedShow: 0.75, sampleSize: 45 });
  });

  it('reports not enough data when no bucket clears the sample-size bar', async () => {
    const root = await tempDir();
    await fill(root, 'canvas-a', 'reviewer', 0.9, 'applied', 5);
    await fill(root, 'canvas-a', 'reviewer', 0.9, 'dismissed', 1);
    const suggestions = await jevCalibration(root);
    const reviewer = suggestions.find(item => item.kind === 'reviewer');
    expect(reviewer).toMatchObject({ suggestedShow: null, sampleSize: 6, note: 'Not enough data' });
  });

  it('maps purpose and work_area feedback onto the shared label control', async () => {
    const root = await tempDir();
    await fill(root, 'canvas-a', 'purpose', 0.9, 'applied', 12);
    await fill(root, 'canvas-b', 'work_area', 0.9, 'applied', 10);
    await fill(root, 'canvas-b', 'work_area', 0.9, 'dismissed', 2);
    const suggestions = await jevCalibration(root);
    const label = suggestions.find(item => item.kind === 'label');
    expect(label).toMatchObject({ suggestedShow: 0.85, sampleSize: 24 });
  });

  it('skips categories with no clear matching policy control', async () => {
    const root = await tempDir();
    await fill(root, 'canvas-a', 'duplicate', 0.9, 'applied', 30);
    await fill(root, 'canvas-a', 'quality', 0.9, 'applied', 30);
    await fill(root, 'canvas-a', 'relation', 0.9, 'applied', 30);
    await fill(root, 'canvas-a', 'supersedes', 0.9, 'applied', 30);
    const suggestions = await jevCalibration(root);
    expect(suggestions).toEqual([]);
  });

  it('aggregates feedback across every canvas file', async () => {
    const root = await tempDir();
    await fill(root, 'canvas-a', 'stale', 0.9, 'applied', 15);
    await fill(root, 'canvas-b', 'stale', 0.9, 'applied', 15);
    const suggestions = await jevCalibration(root);
    const stale = suggestions.find(item => item.kind === 'stale');
    expect(stale).toMatchObject({ suggestedShow: 0.85, sampleSize: 30 });
  });

  it('returns an empty list when no feedback has been recorded', async () => {
    const root = await tempDir();
    expect(await jevCalibration(root)).toEqual([]);
    expect(await feedbackSummary(root)).toEqual([]);
  });
});
