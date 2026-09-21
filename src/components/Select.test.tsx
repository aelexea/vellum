/**
 * Select internals tests (§8 F6): keyboard nav, the auto-search threshold above
 * 8 options, search filtering (label + value) and the 200-row render cap.
 * Props API is frozen — these assert the polished internals only.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from '@/components/Select';
import type { SelectOption } from '@/components/Select';

const FEW: SelectOption[] = [
  { value: 'ru', label: 'Russian' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
];

/** More than the 8-option threshold, so search turns on automatically. */
const MANY: SelectOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'date', label: 'Date' },
  { value: 'fig', label: 'Fig' },
  { value: 'grape', label: 'Grape' },
  { value: 'kiwi', label: 'Kiwi' },
  { value: 'lemon', label: 'Lemon' },
];

const combo = (name = 'Choice') => screen.getByRole('combobox', { name });

const open = (name = 'Choice') => fireEvent.click(combo(name));

describe('Select', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the selected label and the placeholder when unset', () => {
    const { rerender } = render(
      <Select options={FEW} value="en" onChange={() => {}} ariaLabel="Choice" />,
    );
    expect(combo()).toHaveTextContent('English');

    rerender(<Select options={FEW} value={null} onChange={() => {}} ariaLabel="Choice" />);
    expect(combo()).toHaveTextContent('Not selected');
  });

  it('opens on Enter, moves with the arrows and commits the highlighted row', () => {
    const onChange = vi.fn();
    render(<Select options={FEW} value="ru" onChange={onChange} ariaLabel="Choice" />);

    fireEvent.keyDown(combo(), { key: 'Enter' });
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    // Active row starts on the selected option (ru).
    fireEvent.keyDown(combo(), { key: 'ArrowDown' });
    fireEvent.keyDown(combo(), { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('en');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on ArrowDown/ArrowUp without changing the value', () => {
    const onChange = vi.fn();
    render(<Select options={FEW} value={null} onChange={onChange} ariaLabel="Choice" />);

    fireEvent.keyDown(combo(), { key: 'ArrowDown' });
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps at both ends and jumps with Home/End', () => {
    render(<Select options={FEW} value={null} onChange={() => {}} ariaLabel="Choice" />);
    open();

    fireEvent.keyDown(combo(), { key: 'ArrowUp' });
    fireEvent.keyDown(combo(), { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'Russian' })).toHaveAttribute('data-active', 'true');

    fireEvent.keyDown(combo(), { key: 'End' });
    expect(screen.getByRole('option', { name: 'German' })).toHaveAttribute('data-active', 'true');

    fireEvent.keyDown(combo(), { key: 'Home' });
    expect(screen.getByRole('option', { name: 'Russian' })).toHaveAttribute('data-active', 'true');
  });

  it('closes on Escape without committing', () => {
    const onChange = vi.fn();
    render(<Select options={FEW} value="ru" onChange={onChange} ariaLabel="Choice" />);
    open();
    fireEvent.keyDown(combo(), { key: 'ArrowDown' });
    fireEvent.keyDown(combo(), { key: 'Escape' });

    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on outside click', () => {
    render(
      <div>
        <Select options={FEW} value="ru" onChange={() => {}} ariaLabel="Choice" />
        <span data-testid="outside">elsewhere</span>
      </div>,
    );
    open();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
  });

  it('commits on click and marks aria-selected', () => {
    const onChange = vi.fn();
    render(<Select options={FEW} value="ru" onChange={onChange} ariaLabel="Choice" />);
    open();

    expect(screen.getByRole('option', { name: 'Russian' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'German' }));
    expect(onChange).toHaveBeenCalledWith('de');
  });

  it('does not commit a disabled option', () => {
    const onChange = vi.fn();
    render(
      <Select
        options={[...FEW, { value: 'fr', label: 'French', disabled: true }]}
        value="ru" onChange={onChange} ariaLabel="Choice"
      />,
    );
    open();
    fireEvent.click(screen.getByRole('option', { name: 'French' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders no search box at or below 8 options', () => {
    render(<Select options={FEW} value="ru" onChange={() => {}} ariaLabel="Choice" />);
    open();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('turns the search field on automatically above 8 options', () => {
    render(<Select options={MANY} value="apple" onChange={() => {}} ariaLabel="Choice" />);
    open();
    expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument();
  });

  it('honours an explicit searchable={false} even for a long list', () => {
    render(
      <Select options={MANY} value="apple" onChange={() => {}} ariaLabel="Choice" searchable={false} />,
    );
    open();
    expect(screen.queryByPlaceholderText('Search…')).not.toBeInTheDocument();
  });

  it('filters by label', () => {
    const onChange = vi.fn();
    render(<Select options={MANY} value="apple" onChange={onChange} ariaLabel="Choice" />);
    open();
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'ban' } });

    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent('Banana');

    fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('banana');
  });

  it('filters by value, not only by label', () => {
    render(<Select options={MANY} value="apple" onChange={() => {}} ariaLabel="Choice" />);
    open();
    // "ap" matches apple/apricot (label and value) and gr-ap-e by value — three rows.
    // Important for the language picker, whose values are ISO codes ("ru", "en").
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'ap' } });

    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(3);
    expect(opts.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Apple', 'Apricot', 'Grape']),
    );
  });

  it('shows the empty state when nothing matches', () => {
    render(<Select options={MANY} value="apple" onChange={() => {}} ariaLabel="Choice" />);
    open();
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('caps the rendered rows at 200', () => {
    const many: SelectOption[] = Array.from({ length: 450 }, (_, i) => ({
      value: `v${i}`, label: `Language ${i}`,
    }));
    render(<Select options={many} value="v0" onChange={() => {}} ariaLabel="Choice" />);
    open();
    expect(screen.getAllByRole('option')).toHaveLength(200);
  });

  it('narrowing by query reaches rows past the cap', () => {
    const many: SelectOption[] = Array.from({ length: 450 }, (_, i) => ({
      value: `v${i}`, label: `Language ${i}`,
    }));
    render(<Select options={many} value="v0" onChange={() => {}} ariaLabel="Choice" />);
    open();
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Language 4' } });
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: 'Language 400' })).toBeInTheDocument();
  });

  it('is inert while disabled', () => {
    const onChange = vi.fn();
    render(
      <Select options={FEW} value="ru" onChange={onChange} ariaLabel="Choice" disabled />,
    );
    expect(combo()).toBeDisabled();
    fireEvent.keyDown(combo(), { key: 'Enter' });
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the custom option renderer when provided', () => {
    render(
      <Select
        options={FEW} value="ru" onChange={() => {}} ariaLabel="Choice"
        renderOption={(o) => <span data-testid={`row-${o.value}`}>{o.label} ★</span>}
      />,
    );
    open();
    expect(screen.getByTestId('row-ru')).toHaveTextContent('Russian ★');
  });
});
