import { useEffect, useState } from 'react';

type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Issue = { field: FormField; message: string; top: number; left: number };

const messageId = 'app-validation-message';

function fieldName(field: FormField): string {
  const label = field.getAttribute('aria-label') ?? field.labels?.[0]?.firstChild?.textContent ?? '';
  return label.trim() || 'This field';
}

function showIssue(field: FormField): Issue {
  field.focus();
  const box = field.getBoundingClientRect();
  const message = field.validity.valueMissing ? `${fieldName(field)} is required.` : field.validationMessage;
  return { field, message, top: box.bottom + 6, left: box.left };
}

/** Replaces the browser's native validation bubble with one message styled like the rest of the app. */
export function ValidationMessage() {
  const [issue, setIssue] = useState<Issue | null>(null);
  useEffect(() => {
    let reported = false;
    function onInvalid(event: Event) {
      event.preventDefault();
      // One submit fires an invalid event per field, synchronously; report only the first of that batch.
      if (reported) return;
      reported = true;
      queueMicrotask(() => { reported = false; });
      setIssue(showIssue(event.target as FormField));
    }
    document.addEventListener('invalid', onInvalid, true);
    return () => document.removeEventListener('invalid', onInvalid, true);
  }, []);
  useEffect(() => {
    if (!issue) return;
    const { field } = issue;
    const clear = () => setIssue(null);
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', messageId);
    field.addEventListener('input', clear);
    field.addEventListener('blur', clear);
    window.addEventListener('resize', clear);
    return () => {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      field.removeEventListener('input', clear);
      field.removeEventListener('blur', clear);
      window.removeEventListener('resize', clear);
    };
  }, [issue]);
  if (!issue) return null;
  return <p id={messageId} className="validation-message" role="alert" style={{ top: issue.top, left: issue.left }}>{issue.message}</p>;
}
