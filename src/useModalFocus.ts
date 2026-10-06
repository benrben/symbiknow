import { useLayoutEffect, useState, type RefObject } from 'react';
import { useEscapeLayer } from './escape-layers';

const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function focusable(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(element => !element.closest('[hidden], [aria-hidden="true"], [inert]'))
    .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

function shouldIsolate(sibling: Element, ancestor: HTMLElement): sibling is HTMLElement {
  return sibling !== ancestor && sibling instanceof HTMLElement && !sibling.hasAttribute('inert');
}

function isolateBackground(dialog: HTMLElement): () => void {
  const isolated: HTMLElement[] = [];
  let ancestor: HTMLElement | null = dialog;
  while (ancestor?.parentElement) {
    for (const sibling of ancestor.parentElement.children) {
      if (!shouldIsolate(sibling, ancestor)) continue;
      sibling.setAttribute('inert', '');
      isolated.push(sibling);
    }
    ancestor = ancestor.parentElement;
  }
  return () => { for (const element of isolated) element.removeAttribute('inert'); };
}

function focusEdges(dialog: HTMLElement) {
  const targets = focusable(dialog);
  return { first: targets[0] ?? dialog, last: targets.at(-1) ?? dialog };
}

function moveFocus(event: KeyboardEvent, dialog: HTMLElement): void {
  const { first, last } = focusEdges(dialog);
  const boundary = event.shiftKey ? first : last;
  if (dialog.contains(document.activeElement) && document.activeElement !== boundary) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

export function useModalFocus(dialogRef: RefObject<HTMLElement | null>, onEscape: () => void, busy: boolean): void {
  const [mounted, setMounted] = useState(false);
  useEscapeLayer(mounted, () => { if (!busy) onEscape(); });
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    setMounted(Boolean(dialog));
    if (!dialog) return;
    const opener = document.activeElement;
    const restoreBackground = isolateBackground(dialog);
    const focusFirst = () => (focusable(dialog)[0] ?? dialog).focus();
    const onFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') moveFocus(event, dialog);
    };
    focusFirst();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      restoreBackground();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [dialogRef]);
}
