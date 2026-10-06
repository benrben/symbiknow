// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationMessage } from './ValidationMessage';

function Form() {
  return <form onSubmit={event => event.preventDefault()}>
    <label>Workspace name<input required/></label>
    <input aria-label="Model" required/>
    <input type="email" aria-label="  " defaultValue="not an email"/>
    <button>Create</button>
  </form>;
}

function submit() { fireEvent.click(screen.getByRole('button', { name: 'Create' })); }

afterEach(cleanup);

describe('ValidationMessage', () => {
  it('shows one app-styled message for the first invalid field instead of the native bubble', () => {
    render(<><Form/><ValidationMessage/></>);
    submit();
    const field = screen.getByRole('textbox', { name: 'Workspace name' });
    const message = screen.getByRole('alert');
    expect(message.textContent).toBe('Workspace name is required.');
    expect(message.className).toBe('validation-message');
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(message.id);
    expect(screen.getByRole('textbox', { name: 'Model' }).hasAttribute('aria-invalid')).toBe(false);
  });

  it('clears when the person edits, leaves the field, or resizes the window', async () => {
    render(<><Form/><ValidationMessage/></>);
    const field = screen.getByRole('textbox', { name: 'Workspace name' });
    for (const dismiss of [() => fireEvent.input(field, { target: { value: 'Team' } }), () => fireEvent.blur(field),
      () => fireEvent(window, new Event('resize'))]) {
      fireEvent.input(field, { target: { value: '' } });
      await Promise.resolve();
      submit();
      expect(screen.getByRole('alert')).toBeTruthy();
      act(dismiss);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(field.hasAttribute('aria-invalid')).toBe(false);
    }
  });

  it('reports the first invalid field of each new submit, by aria-label or the browser reason', async () => {
    render(<><Form/><ValidationMessage/></>);
    fireEvent.input(screen.getByRole('textbox', { name: 'Workspace name' }), { target: { value: 'Team' } });
    submit();
    expect(screen.getByRole('alert').textContent).toBe('Model is required.');
    await Promise.resolve();
    fireEvent.input(screen.getByRole('textbox', { name: 'Model' }), { target: { value: 'gpt' } });
    submit();
    expect(screen.getByRole('alert').textContent).not.toMatch(/required/);
    expect(document.activeElement?.getAttribute('type')).toBe('email');
  });

  it('uses a generic name when a required field has no label at all', () => {
    render(<><form onSubmit={event => event.preventDefault()}><input required/><button>Create</button></form><ValidationMessage/></>);
    submit();
    expect(screen.getByRole('alert').textContent).toBe('This field is required.');
  });
});
