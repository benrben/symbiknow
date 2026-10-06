import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

type FocusTarget = Element & HTMLOrSVGElement;
function activeElement() { return document.activeElement as FocusTarget | null; }

function focusableItems(scope: HTMLElement | null | undefined) {
  return [...(scope?.querySelectorAll<HTMLElement>('*') ?? [])]
    .filter(item => item.matches(focusableSelector) && !item.closest('[hidden]') && !item.hasAttribute('hidden'));
}

export function cycleModalFocus(scope: HTMLElement | null | undefined, event: KeyboardEvent<HTMLElement>) {
  const items = focusableItems(scope);
  if (!items.length) return;
  const boundary = event.shiftKey ? items[0] : items.at(-1);
  if (document.activeElement !== boundary) return;
  event.preventDefault();
  (event.shiftKey ? items.at(-1) : items[0])?.focus();
}

export function useModalFocus(modalRef: RefObject<HTMLDivElement | null>, confirmClose: boolean) {
  const returnFocus = useRef(activeElement());
  const draftFocus = useRef<FocusTarget | null>(null);
  const hadWarning = useRef(false);
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    if (!modal.contains(document.activeElement)) modal.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')?.focus();
    return () => returnFocus.current?.focus();
  }, []);
  useEffect(() => {
    if (confirmClose) { hadWarning.current = true; return; }
    if (!hadWarning.current) return;
    hadWarning.current = false;
    draftFocus.current?.focus();
  }, [confirmClose]);
  return () => { draftFocus.current = activeElement(); };
}
