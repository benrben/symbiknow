import { avatarPose, avatarPoses, type AvatarSize, type AvatarState } from './avatar-types';

export type AssistantAvatarProps = {
  name?: 'Symbi' | 'Jev' | 'Symbi Reflex';
  state?: AvatarState;
  size?: AvatarSize;
  decorative?: boolean;
};

/** Shared artwork, with each mounted assistant retaining its own activity. */
export function AssistantAvatar({ name = 'Symbi', state = 'idle', size = 'medium', decorative = false }: AssistantAvatarProps) {
  const pose = avatarPose(state);
  const identity = name === 'Symbi Reflex' ? 'symbi-reflex' : name.toLowerCase();
  const legacyIdentity = name === 'Symbi Reflex' ? 'jev' : identity;
  const cell = avatarPoses.indexOf(pose);
  const backgroundPosition = `${(cell % 4) / 3 * 100}% ${Math.floor(cell / 4) / 3 * 100}%`;
  return <span
    className={`assistant-character assistant-character--${size} assistant-character--${pose} ${identity}-avatar ${legacyIdentity}-avatar ${legacyIdentity}-avatar--${size} ${legacyIdentity}-avatar--${state}`}
    data-avatar-name={name} data-avatar-state={state} data-avatar-pose={pose}
    role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined}
    aria-label={decorative ? undefined : `${name} ${state}`}>
    <span key={state} className="assistant-character__art" style={{ backgroundPosition }} aria-hidden="true" />
  </span>;
}
