import { AssistantAvatar, type AssistantAvatarProps } from './AssistantAvatar';
import './assistant-avatar.css';

export type { AvatarState as JevState } from './avatar-types';

export function JevAvatar(props: Omit<AssistantAvatarProps, 'name'>) {
  return <AssistantAvatar {...props} name="Symbi Reflex" />;
}
