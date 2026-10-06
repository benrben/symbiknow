import { AssistantAvatar, type AssistantAvatarProps } from './AssistantAvatar';

export type { SymbiState } from './avatar-types';

export function SymbiAvatar(props: Omit<AssistantAvatarProps, 'name'>) {
  return <AssistantAvatar {...props} name="Symbi" />;
}
