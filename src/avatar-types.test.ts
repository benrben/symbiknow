import { describe, expect, it } from 'vitest';
import { avatarPose, avatarPoses, type AvatarState } from './avatar-types';

describe('shared assistant poses', () => {
  it.each(avatarPoses)('preserves the %s activity', pose => {
    expect(avatarPose(pose)).toBe(pose);
  });

  it.each<[AvatarState, string]>([
    ['idle', 'resting'], ['navigating', 'moving'], ['tooling', 'working'],
    ['speaking', 'talking'], ['error', 'asking'], ['paused', 'resting'],
    ['cancelled', 'resting'], ['unavailable', 'asking'],
  ])('maps legacy or interrupted %s to %s without success feedback', (state, pose) => {
    expect(avatarPose(state)).toBe(pose);
    expect(avatarPose(state)).not.toBe('done');
  });
});
