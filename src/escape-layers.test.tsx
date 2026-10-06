// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscapeLayer } from './escape-layers';

function Layer({ name, open = true, onClose }: { name: string; open?: boolean; onClose: (name: string) => void }) {
  useEscapeLayer(open, () => onClose(name));
  return <button type="button">{name}</button>;
}

function Stack({ onClose }: { onClose: (name: string) => void }) {
  const [open, setOpen] = useState(['reader']);
  const close = (name: string) => { onClose(name); setOpen(current => current.filter(item => item !== name)); };
  return <>
    <button type="button" onClick={() => setOpen(current => [...current, 'history'])}>Open history</button>
    {open.map(name => <Layer key={name} name={name} onClose={close}/>)}
  </>;
}

afterEach(cleanup);

describe('useEscapeLayer', () => {
  it('closes only the most recently opened layer on each Escape, wherever focus is', () => {
    const closed = vi.fn();
    const view = render(<Stack onClose={closed}/>);
    fireEvent.click(view.getByText('Open history'));
    act(() => { document.body.focus(); });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed.mock.calls).toEqual([['history']]);
    fireEvent.keyDown(view.getByText('Open history'), { key: 'Escape' });
    expect(closed.mock.calls).toEqual([['history'], ['reader']]);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('keeps a handled Escape from reaching other handlers, and ignores other keys, IME composition and closed layers', () => {
    const closed = vi.fn();
    const seen = vi.fn();
    const view = render(<><Layer name="search" onClose={closed}/><Layer name="hidden" open={false} onClose={closed}/>
      <input aria-label="Editor" onKeyDown={event => seen(event.key)}/></>);
    fireEvent.keyDown(view.getByLabelText('Editor'), { key: 'Enter' });
    fireEvent.keyDown(view.getByLabelText('Editor'), { key: 'Escape', isComposing: true });
    expect(closed).not.toHaveBeenCalled();
    fireEvent.keyDown(view.getByLabelText('Editor'), { key: 'Escape' });
    expect(closed).toHaveBeenCalledExactlyOnceWith('search');
    expect(seen.mock.calls).toEqual([['Enter'], ['Escape']]);
  });

  it('calls the latest close handler without reordering the layer', () => {
    const calls: string[] = [];
    const view = render(<><Layer name="first" onClose={name => calls.push(`old ${name}`)}/><Layer name="second" onClose={name => calls.push(name)}/></>);
    view.rerender(<><Layer name="first" onClose={name => calls.push(`new ${name}`)}/><Layer name="second" onClose={name => calls.push(name)}/></>);
    view.rerender(<><Layer name="first" onClose={name => calls.push(`new ${name}`)}/></>);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(calls).toEqual(['new first']);
  });
});
