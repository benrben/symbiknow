// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useModalFocus } from './useModalFocus';
import { useEscapeLayer } from './escape-layers';

afterEach(cleanup);

it('does not install modal ownership when its element has not been mounted', () => {
  const cancel = vi.fn();
  const view = renderHook(() => useModalFocus({ current: null }, cancel, false));
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(escape);
  expect(cancel).not.toHaveBeenCalled();
  expect(escape.defaultPrevented).toBe(false);
  expect(document.querySelector('[inert]')).toBeNull();
  view.unmount();
});

it('leaves Escape with the mounted background layer when a later modal element is absent', () => {
  const background = vi.fn(); const absent = vi.fn();
  renderHook(() => useEscapeLayer(true, background));
  renderHook(() => useModalFocus({ current: null }, absent, false));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(background).toHaveBeenCalledOnce(); expect(absent).not.toHaveBeenCalled();
});

it('consumes Escape while a mounted dialog is busy and releases ownership on unmount', () => {
  const close = vi.fn();
  function Review({ busy }: { busy: boolean }) {
    const ref = useRef<HTMLDivElement>(null); useModalFocus(ref, close, busy);
    return <div ref={ref} role="dialog" tabIndex={-1}><button>Current review</button></div>;
  }
  const view = render(<Review busy/>);
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(escape); expect(escape.defaultPrevented).toBe(true); expect(close).not.toHaveBeenCalled();
  view.rerender(<Review busy={false}/>);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  const released = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(released); expect(released.defaultPrevented).toBe(false);
});

it('focuses an empty dialog itself, contains both Tab directions and redirects outside focus', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  function Review() {
    const ref = useRef<HTMLDivElement>(null); useModalFocus(ref, vi.fn(), false);
    return <div ref={ref} role="dialog" aria-label="Empty review" tabIndex={-1}/>;
  }
  const view = render(<Review/>); const dialog = screen.getByRole('dialog', { name: 'Empty review' });
  expect(document.activeElement).toBe(dialog);
  for (const shiftKey of [false, true]) {
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    dialog.dispatchEvent(tab); expect(tab.defaultPrevented).toBe(true); expect(document.activeElement).toBe(dialog);
  }
  opener.focus(); expect(document.activeElement).toBe(dialog);
  view.unmount(); expect(document.activeElement).toBe(opener); expect(opener.hasAttribute('inert')).toBe(false);
  opener.remove();
});

it('releases background isolation when the original opener has been removed', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  function Review() {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, vi.fn(), false);
    return <div ref={ref} role="dialog" tabIndex={-1}><button>Review control</button></div>;
  }
  const view = render(<Review/>);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review control' }));
  expect(opener.hasAttribute('inert')).toBe(true);
  opener.remove(); view.unmount();
  expect(document.querySelector('[inert]')).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it('leaves SVG siblings alone while isolating ordinary background controls', () => {
  const graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.append(graphic);
  function Review() {
    const ref = useRef<HTMLDivElement>(null); useModalFocus(ref, vi.fn(), false);
    return <div ref={ref} role="dialog" tabIndex={-1}><button>Review</button></div>;
  }
  const view = render(<Review/>);
  expect(graphic.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review' }));
  view.unmount(); graphic.remove();
});

it('keeps mixed nested controls in native document order through both Tab boundaries and restores the opener', async () => {
  const user = userEvent.setup();
  function Review({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, onClose, false);
    return <div ref={ref} role="dialog" tabIndex={-1} aria-label="Review saved task">
      <button>First action</button>
      <fieldset><input aria-label="Disabled field" disabled/><textarea aria-label="Review notes"/></fieldset>
      <div hidden><button>Hidden action</button></div>
      <section><a href="#task-details">Task details</a><button onClick={onClose}>Last action</button></section>
    </div>;
  }
  function Owner() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open review</button>{open && <Review onClose={() => setOpen(false)}/>}</>;
  }
  render(<Owner/>);
  const opener = screen.getByRole('button', { name: 'Open review' });
  await user.click(opener);
  const first = screen.getByRole('button', { name: 'First action' });
  const notes = screen.getByRole('textbox', { name: 'Review notes' });
  const details = screen.getByRole('link', { name: 'Task details' });
  const last = screen.getByRole('button', { name: 'Last action' });
  expect(document.activeElement).toBe(first);
  for (const target of [notes, details, last, first]) {
    await user.tab();
    expect(document.activeElement).toBe(target);
  }
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(last);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.querySelector('[inert]')).toBeNull();
});
