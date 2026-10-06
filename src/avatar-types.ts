export const avatarPoses = [
  'resting', 'moving', 'listening', 'talking',
  'reading', 'writing', 'asking', 'thinking',
  'searching', 'connecting', 'organizing', 'comparing',
  'checking', 'summarizing', 'working', 'done',
] as const;

export type AvatarPose = typeof avatarPoses[number];
export type AvatarState = AvatarPose | 'idle' | 'navigating' | 'tooling' | 'speaking'
  | 'error' | 'paused' | 'cancelled' | 'unavailable';
export type AvatarSize = 'small' | 'medium' | 'large';
export type SymbiState = AvatarState;

const aliases: Partial<Record<AvatarState, AvatarPose>> = {
  idle: 'resting', navigating: 'moving', tooling: 'working', speaking: 'talking',
  error: 'asking', paused: 'resting', cancelled: 'resting', unavailable: 'asking',
};

export function avatarPose(state: AvatarState): AvatarPose {
  return aliases[state] ?? state as AvatarPose;
}
