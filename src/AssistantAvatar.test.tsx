// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantAvatar } from './AssistantAvatar';
import { SymbiAvatar } from './SymbiAvatar';
import { JevAvatar } from './JevAvatar';
import { avatarPoses, type AvatarState } from './avatar-types';

afterEach(cleanup);

describe('shared assistant artwork', () => {
  it('keeps the existing default Symbi interface and accessible name', () => {
    render(<SymbiAvatar />);
    const avatar = screen.getByRole('img', { name: 'Symbi idle' });
    expect(avatar.classList.contains('symbi-avatar--medium')).toBe(true);
    expect(avatar.dataset.avatarPose).toBe('resting');
    expect(avatar.querySelector('svg')).toBeNull();
    expect(avatar.querySelector<HTMLElement>('.assistant-character__art')?.style.backgroundPosition).toBe('0% 0%');
  });

  it.each(avatarPoses)('renders the %s artwork in its own atlas cell', pose => {
    render(<AssistantAvatar state={pose} size="large" />);
    const avatar = screen.getByRole('img', { name: `Symbi ${pose}` });
    const index = avatarPoses.indexOf(pose);
    expect(avatar.dataset.avatarPose).toBe(pose);
    expect(avatar.classList.contains(`assistant-character--${pose}`)).toBe(true);
    expect(avatar.classList.contains('symbi-avatar--large')).toBe(true);
    expect(avatar.querySelector<HTMLElement>('.assistant-character__art')?.style.backgroundPosition)
      .toBe(`${(index % 4) / 3 * 100}% ${Math.floor(index / 4) / 3 * 100}%`);
  });

  it.each<[AvatarState, string]>([
    ['idle', 'resting'], ['navigating', 'moving'], ['tooling', 'working'], ['speaking', 'talking'],
    ['error', 'asking'], ['paused', 'resting'], ['cancelled', 'resting'], ['unavailable', 'asking'],
  ])('preserves the %s state while using the %s pose', (state, pose) => {
    render(<SymbiAvatar state={state} size="small" />);
    const avatar = screen.getByRole('img', { name: `Symbi ${state}` });
    expect(avatar.dataset.avatarState).toBe(state);
    expect(avatar.dataset.avatarPose).toBe(pose);
    expect(avatar.classList.contains(`symbi-avatar--${state}`)).toBe(true);
    expect(avatar.dataset.avatarPose).not.toBe('done');
  });

  it('hides decorative message artwork from assistive technology', () => {
    const { container } = render(<SymbiAvatar decorative size="small" state="reading" />);
    expect(screen.queryByRole('img')).toBeNull();
    const avatar = container.querySelector('.symbi-avatar');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.getAttribute('aria-label')).toBeNull();
  });

  it('keeps Symbi Reflex independent when Symbi changes activity', () => {
    const { rerender } = render(<><JevAvatar state="organizing" /><SymbiAvatar state="talking" /></>);
    const jev = screen.getByRole('img', { name: 'Symbi Reflex organizing' });
    expect(jev.classList.contains('jev-avatar--organizing')).toBe(true);
    rerender(<><JevAvatar state="organizing" /><SymbiAvatar state="done" /></>);
    expect(screen.getByRole('img', { name: 'Symbi Reflex organizing' })).toBe(jev);
    expect(jev.dataset.avatarPose).toBe('organizing');
    expect(screen.getByRole('img', { name: 'Symbi done' }).dataset.avatarPose).toBe('done');
  });

  it('resets finite completion motion when entering done again', () => {
    const { rerender } = render(<JevAvatar state="done" />);
    const firstArtwork = screen.getByRole('img').firstElementChild;
    rerender(<JevAvatar state="working" />);
    rerender(<JevAvatar state="done" />);
    expect(screen.getByRole('img', { name: 'Symbi Reflex done' }).firstElementChild).not.toBe(firstArtwork);
  });

  it('renders without a browser or SVG identifiers for the static preview', () => {
    const markup = renderToStaticMarkup(<AssistantAvatar name="Jev" state="connecting" decorative />);
    expect(markup).toContain('data-avatar-name="Jev"');
    expect(markup).toContain('background-position:33.33333333333333% 66.66666666666666%');
    expect(markup).not.toContain('<svg');
  });
});
