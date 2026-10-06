// @vitest-environment jsdom
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { cycleModalFocus, useModalFocus } from './app-modal-focus';

afterEach(cleanup);

describe('modal focus boundaries', () => {
  it('leaves Tab available when no scope or focusable content exists', () => {
    function Harness({ missing }: { missing: boolean }) {
      return <div aria-label="Scope" tabIndex={-1} onKeyDown={event => cycleModalFocus(missing ? null : event.currentTarget, event)}>
        <div hidden><button>Hidden action</button></div><input disabled aria-label="Disabled"/>
      </div>;
    }
    const view = render(<Harness missing={false}/>);
    const scope = screen.getByLabelText('Scope'); scope.focus(); expect(fireEvent.keyDown(scope, { key: 'Tab' })).toBe(true);
    view.rerender(<Harness missing/>); expect(fireEvent.keyDown(scope, { key: 'Tab' })).toBe(true);
  });

  it('does not assume a mounted dialog when the optional focus scope is absent', () => {
    const hook = renderHook(() => useModalFocus(useRef<HTMLDivElement>(null), false));
    expect(() => hook.result.current()).not.toThrow(); hook.unmount();
  });

  it('restores a keyboard accessible SVG opener after the modal closes', () => {
    const openerView = render(<svg aria-label="Editor opener" tabIndex={0}/>);
    const opener = screen.getByLabelText('Editor opener') as unknown as SVGSVGElement; opener.focus();
    expect(document.activeElement).toBe(opener);
    function Dialog() {
      const ref = useRef<HTMLDivElement>(null); useModalFocus(ref, false);
      return <div ref={ref} role="dialog"><button>Close</button></div>;
    }
    const view = render(<Dialog/>); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    view.unmount(); expect(document.activeElement).toBe(opener); openerView.unmount();
  });
});
