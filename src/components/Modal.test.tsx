/**
 * Modal internals tests (§8 F6): Esc + backdrop close, Tab focus trap, autofocus,
 * body scroll lock. Props API is frozen — these assert the polished internals only.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from '@/components/Modal';

describe('Modal', () => {
  beforeEach(() => { document.body.style.overflow = ''; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} title="T">body</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click by default', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} title="T">body</Modal>);
    fireEvent.mouseDown(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on backdrop click when closeOnBackdrop is false', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} title="T" closeOnBackdrop={false}>body</Modal>);
    fireEvent.mouseDown(screen.getByRole('presentation'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('autofocuses the first input', () => {
    render(<Modal onClose={() => {}} title="T"><input data-testid="field" /></Modal>);
    expect(screen.getByTestId('field')).toHaveFocus();
  });

  it('focuses the dialog when there is no focusable field', () => {
    render(<Modal onClose={() => {}} title="T">plain text</Modal>);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('locks body scroll while open and restores it on unmount', () => {
    const { unmount } = render(<Modal onClose={() => {}} title="T">body</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('traps Tab forward from the last focusable back to the first', () => {
    render(
      <Modal onClose={() => {}} title="T">
        <button type="button">A</button>
        <input data-testid="mid" />
        <button type="button">B</button>
      </Modal>,
    );
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'B' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('traps Shift+Tab backward from the first focusable to the last', () => {
    render(
      <Modal onClose={() => {}} title="T">
        <button type="button">A</button>
        <input data-testid="mid" />
        <button type="button">B</button>
      </Modal>,
    );
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'B' });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('renders nothing when open is false', () => {
    render(<Modal open={false} onClose={() => {}} title="T">body</Modal>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
