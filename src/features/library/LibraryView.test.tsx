/**
 * LibraryView / BookCard / TagsBar / ImportBar — [F1] tests per ARCHITECTURE.md §8.
 *
 * Stores are the real frozen zustand implementations, seeded via setState; the Tauri surface
 * is mocked by src/test/setup.ts. `list_books` is re-pointed at the seeded fixtures so the
 * reload that setFilter() triggers stays idempotent instead of restoring the single default
 * fixture book.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BookMeta, Tag } from '@/lib/types';
import { ConfirmHost } from '@/components/Modal';
import { DEFAULT_FILTER, useLibraryStore } from '@/stores/libraryStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { invokeCalls, mockCommand } from '@/test/setup';
import LibraryView, { selectBooks, SORT_OPTIONS } from '@/features/library/LibraryView';
import { hueFromUid, pctOf, titleInitials } from '@/features/library/BookCard';
import type { LibraryFilter } from '@/lib/types';

// -------------------------------------------------------------------- fixtures

let uidSeq = 0;

function makeBook(over: Partial<BookMeta> = {}): BookMeta {
  uidSeq += 1;
  return {
    uid: `uid${String(uidSeq).padStart(6, '0')}`,
    title: `Книга ${uidSeq}`,
    authors: ['Автор'],
    path: `/books/${uidSeq}.epub`,
    coverUrl: null,
    progress: 0,
    positionChapterIdx: null,
    totalChapters: 0,
    addedAt: 1_700_000_000_000,
    lastOpenedAt: null,
    tags: [],
    sizeBytes: 1024,
    missing: false,
    ...over,
  };
}

/** Seed libraryStore + point list_books/list_tags at the same data. */
function seed(books: BookMeta[], tags: Tag[] = []): void {
  useLibraryStore.setState({
    books,
    tags,
    filter: { ...DEFAULT_FILTER },
    loading: false,
    importing: false,
    importProgress: null,
  });
  mockCommand('list_books', books);
  mockCommand('list_tags', tags);
}

const invoked = (cmd: string) => invokeCalls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  uidSeq = 0;
  useSettingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    loaded: true,
    fonts: [],
    fontsLoaded: false,
  });
  useUiStore.setState({
    view: 'library',
    overlay: null,
    toasts: [],
    pendingConfirm: null,
    booting: false,
  });
  seed([]);
});

const cards = () => screen.queryAllByTestId('book-card');

// ----------------------------------------------------------------- pure helpers

describe('card helpers', () => {
  it('derives a stable, in-range hue and initials for fallback covers', () => {
    const a = hueFromUid('abc123');
    expect(a).toBe(hueFromUid('abc123'));          // deterministic
    expect(hueFromUid('abc124')).not.toBe(a);       // uid-sensitive
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);

    expect(titleInitials('Война и мир')).toBe('ВМ');   // conjunction "и" skipped
    expect(titleInitials('Мoby Dick')).toBe('МD');
    expect(titleInitials('Одиночество')).toBe('О');      // single word → one initial
    expect(titleInitials('')).toBe('…');
  });

  it('maps progress to a whole percent', () => {
    expect(pctOf(0.25)).toBe(25);
    expect(pctOf(0)).toBe(0);
    expect(pctOf(1)).toBe(100);
    expect(pctOf(1.7)).toBe(100);                   // clamped
    expect(pctOf(-0.2)).toBe(0);
  });
});

describe('selectBooks', () => {
  const alice = makeBook({ title: 'Алиса', authors: ['Кэрролл'], progress: 0.5, lastOpenedAt: 300 });
  const frank = makeBook({ title: 'Франкенштейн', authors: ['Шелли'], progress: 0.1, lastOpenedAt: 100 });
  const war = makeBook({ title: 'Война и мир', authors: ['Толстой'], progress: 0.9, lastOpenedAt: 200 });
  const all = [alice, frank, war];

  const withFilter = (p: Partial<LibraryFilter>) =>
    selectBooks(all, { ...DEFAULT_FILTER, ...p }).map((b) => b.title);

  it('sorts by title, author and progress, honoring sortDesc', () => {
    expect(withFilter({ sort: 'title', sortDesc: false })).toEqual(['Алиса', 'Война и мир', 'Франкенштейн']);
    expect(withFilter({ sort: 'title', sortDesc: true })).toEqual(['Франкенштейн', 'Война и мир', 'Алиса']);
    // Кэрролл < Толстой < Шелли in the Russian alphabet
    expect(withFilter({ sort: 'author', sortDesc: false })).toEqual(['Алиса', 'Война и мир', 'Франкенштейн']);
    expect(withFilter({ sort: 'progress', sortDesc: true })).toEqual(['Война и мир', 'Алиса', 'Франкенштейн']);
    expect(withFilter({ sort: 'lastOpened', sortDesc: true })).toEqual(['Алиса', 'Война и мир', 'Франкенштейн']);
  });

  it('filters by query (title or author) and by tag', () => {
    expect(withFilter({ query: 'али' })).toEqual(['Алиса']);
    expect(withFilter({ query: 'шелли' })).toEqual(['Франкенштейн']);
    expect(withFilter({ query: '   ' })).toHaveLength(3);      // blank query matches all

    const tagged = selectBooks(
      [makeBook({ title: 'T1', tags: ['ru'] }), makeBook({ title: 'T2', tags: ['en'] })],
      { ...DEFAULT_FILTER, tag: 'ru' },
    ).map((b) => b.title);
    expect(tagged).toEqual(['T1']);
  });

  it('applies the missing-file mode', () => {
    const gone = makeBook({ title: 'Пропавшая', missing: true });
    const present = makeBook({ title: 'На месте', missing: false });
    const both = [present, gone];

    // 'hide' is the default: missing files never appear.
    expect(selectBooks(both, { ...DEFAULT_FILTER, missing: 'hide' }).map((b) => b.title))
      .toEqual(['На месте']);
    expect(selectBooks(both, { ...DEFAULT_FILTER, missing: 'all' }).map((b) => b.title).sort())
      .toEqual(['На месте', 'Пропавшая'].sort());
    expect(selectBooks(both, { ...DEFAULT_FILTER, missing: 'only' }).map((b) => b.title))
      .toEqual(['Пропавшая']);
  });
});

// -------------------------------------------------------------------- rendering

describe('LibraryView', () => {
  it('renders one card per book plus the exact §6.9 header copy', () => {
    seed([makeBook({ title: 'Алиса' }), makeBook({ title: 'Франкенштейн' }), makeBook({ title: 'Война и мир' })]);
    render(<LibraryView />);

    expect(cards()).toHaveLength(3);
    expect(screen.getByTestId('wordmark')).toHaveTextContent('Vellum');
    expect(screen.getByPlaceholderText('Search books…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add books' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan folder' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Recently opened');
  });

  it('shows all five §6.9 sort options', () => {
    expect(SORT_OPTIONS.map((o) => o.label)).toEqual([
      'Recently opened', 'Title', 'Author', 'Progress', 'Date added',
    ]);
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(['lastOpened', 'title', 'author', 'progress', 'added']);
  });

  it('renders the empty state with both CTAs when the library is empty', () => {
    seed([]);
    render(<LibraryView />);

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('empty-art')).toBeInTheDocument();
    expect(screen.getByText('Add your first book')).toBeInTheDocument();
    expect(screen.getByText('Choose EPUB files or a folder of books')).toBeInTheDocument();
    expect(screen.getByTestId('empty-add')).toHaveTextContent('Add books');
    expect(screen.getByTestId('empty-scan')).toHaveTextContent('Scan folder');
  });

  it('filters instantly as the user types in the search field', async () => {
    seed([makeBook({ title: 'Алиса' }), makeBook({ title: 'Франкенштейн' })]);
    render(<LibraryView />);

    const input = screen.getByPlaceholderText('Search books…');
    fireEvent.change(input, { target: { value: 'али' } });

    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveAttribute('aria-label', 'Open Алиса');
    expect(useLibraryStore.getState().filter.query).toBe('али');

    // Clearing restores everything; no list_books round-trip was needed for the filter.
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(useLibraryStore.getState().filter.query).toBeNull();
  });

  it('filters by tag chip and resets via "All tags"', async () => {
    seed(
      [makeBook({ title: 'Алиса', tags: ['en'] }), makeBook({ title: 'Война и мир', tags: ['ru'] })],
      [{ id: 1, name: 'en', count: 1 }, { id: 2, name: 'ru', count: 1 }],
    );
    render(<LibraryView />);

    const bar = screen.getByTestId('tags-bar');
    expect(within(bar).getByTestId('chip-tag-ru')).toHaveTextContent('ru');
    expect(within(bar).getByTestId('chip-tag-ru')).toHaveTextContent('1');
    expect(within(bar).getByTestId('chip-all')).toHaveTextContent('All tags');

    fireEvent.click(within(bar).getByTestId('chip-tag-ru'));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveAttribute('aria-label', 'Open Война и мир');
    expect(useLibraryStore.getState().filter.tag).toBe('ru');

    fireEvent.click(within(bar).getByTestId('chip-all'));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(useLibraryStore.getState().filter.tag).toBeNull();
  });

  it('hides the tag bar when there are no tags', () => {
    seed([makeBook()], []);
    render(<LibraryView />);
    expect(screen.queryByTestId('tags-bar')).not.toBeInTheDocument();
  });

  it('reorders cards when the sort select changes', async () => {
    seed([
      makeBook({ title: 'Франкенштейн', lastOpenedAt: 300 }),
      makeBook({ title: 'Алиса', lastOpenedAt: 100 }),
    ]);
    render(<LibraryView />);

    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual([
      'Open Франкенштейн', 'Open Алиса',
    ]);

    fireEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Title' }));

    await waitFor(() => expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual([
      'Open Алиса', 'Open Франкенштейн',
    ]));
    expect(useLibraryStore.getState().filter.sort).toBe('title');
  });

  it('switches to list view with percent readout and a permanent menu button', async () => {
    seed([makeBook({ title: 'Алиса', progress: 0.42 })]);
    render(<LibraryView />);

    fireEvent.click(screen.getByTestId('view-list'));
    await waitFor(() => expect(screen.getByTestId('list')).toBeInTheDocument());

    const row = cards()[0];
    expect(within(row).getByText('42 %')).toBeInTheDocument();
    expect(within(row).getByTestId('card-menu')).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.library.view).toBe('list');
  });

  it('renders the progress bar with the width matching book progress', () => {
    seed([makeBook({ title: 'Алиса', progress: 0.25 })]);
    render(<LibraryView />);

    const bar = screen.getByTestId('progress-bar');
    expect(bar.style.width).toBe('25%');
    expect(bar.closest('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '25');
  });

  it('dims a missing book and shows the "File unavailable" badge', () => {
    seed([
      makeBook({ title: 'Алиса', missing: false }),
      makeBook({ title: 'Пропавшая', missing: true }),
    ]);
    // missing defaults to 'hide' — surface them all so the badge is reachable.
    useLibraryStore.setState((s) => ({ filter: { ...s.filter, missing: 'all' } }));
    render(<LibraryView />);

    expect(cards()).toHaveLength(2);
    const badges = screen.getAllByTestId('missing-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('File unavailable');

    const missingCard = cards().find((c) => c.getAttribute('aria-label') === 'Open Пропавшая');
    expect(missingCard?.className).toContain('opacity-60');
  });

  it('offers a "File unavailable" chip that toggles the missing filter', async () => {
    seed([makeBook({ title: 'Алиса' }), makeBook({ title: 'Пропавшая', missing: true })]);
    render(<LibraryView />);

    const chip = screen.getByTestId('chip-missing');
    fireEvent.click(chip);
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveAttribute('aria-label', 'Open Пропавшая');
    expect(useLibraryStore.getState().filter.missing).toBe('only');

    fireEvent.click(screen.getByTestId('chip-missing'));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(useLibraryStore.getState().filter.missing).toBe('hide');
  });

  it('falls back to a generated gradient cover with initials', () => {
    seed([makeBook({ uid: 'abc123', title: 'Война и мир', coverUrl: null })]);
    render(<LibraryView />);

    const fb = screen.getByTestId('cover-fallback');
    expect(fb).toHaveTextContent('ВМ');                       // "и" skipped
    expect(fb.style.background).toContain('linear-gradient');
    // jsdom normalizes hsl() to rgb(), so assert the hue through the data attribute.
    expect(fb).toHaveAttribute('data-hue', String(hueFromUid('abc123')));
  });

  it('requests the cover lazily and falls back when it fails to load', () => {
    seed([makeBook({ uid: 'zz9', title: 'Алиса', coverUrl: 'vellum://covers/zz9' })]);
    render(<LibraryView />);

    // alt="" keeps the cover presentational, so it is not exposed as role="img".
    const img = screen.getByTestId('book-card').querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'vellum://covers/zz9');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');

    fireEvent.error(img!);
    expect(screen.getByTestId('cover-fallback')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ interactions

describe('LibraryView interactions', () => {
  it('opens the book via uiStore.openBook when the card is clicked', async () => {
    const book = makeBook({ title: 'Алиса' });
    seed([book]);
    const spy = vi.spyOn(useUiStore.getState(), 'openBook').mockResolvedValue(undefined);
    render(<LibraryView />);

    fireEvent.click(cards()[0]);
    expect(spy).toHaveBeenCalledWith(book.uid);
    spy.mockRestore();
  });

  it('opens the book on Enter and starts deletion on Delete', async () => {
    const book = makeBook({ title: 'Алиса' });
    seed([book]);
    const openSpy = vi.spyOn(useUiStore.getState(), 'openBook').mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(useUiStore.getState(), 'confirmWithCheck')
      .mockResolvedValue({ ok: false, checked: false });
    render(<LibraryView />);

    const card = cards()[0];
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card).toHaveAttribute('role', 'button');

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(openSpy).toHaveBeenCalledWith(book.uid);

    fireEvent.keyDown(card, { key: 'Delete' });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      title: 'Delete book “Алиса”?',
      checkboxLabel: 'Delete file from disk',
    });

    openSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('deletes through the context menu confirm dialog, passing the checkbox state', async () => {
    const book = makeBook({ title: 'Алиса' });
    seed([book]);
    render(
      <>
        <LibraryView />
        <ConfirmHost />
      </>,
    );

    fireEvent.click(screen.getByTestId('card-menu'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Tags…' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Stats' })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Delete book “Алиса”?');
    fireEvent.click(screen.getByLabelText('Delete file from disk'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(invoked('delete_book')).toHaveLength(1));
    expect(invoked('delete_book')[0].args).toEqual({ uid: book.uid, deleteFile: true });
    await waitFor(() => expect(cards()).toHaveLength(0));
  });

  it('keeps the book when the confirm dialog is cancelled', async () => {
    const book = makeBook({ title: 'Алиса' });
    seed([book]);
    render(
      <>
        <LibraryView />
        <ConfirmHost />
      </>,
    );

    fireEvent.click(screen.getByTestId('card-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invoked('delete_book')).toHaveLength(0);
    expect(cards()).toHaveLength(1);
  });

  it('edits tags in the modal: toggle an existing tag, create a new one on Enter', async () => {
    const book = makeBook({ title: 'Алиса', tags: ['en'] });
    seed([book], [{ id: 1, name: 'en', count: 1 }, { id: 2, name: 'классика', count: 0 }]);
    render(<LibraryView />);

    fireEvent.click(screen.getByTestId('card-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tags…' }));

    const modal = await screen.findByTestId('tags-modal');
    expect(within(modal).getByTestId('tag-chip-en')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(modal).getByTestId('tag-chip-классика'));
    fireEvent.keyDown(screen.getByTestId('tag-input'), { key: 'Enter', target: { value: 'новое' } });
    fireEvent.change(screen.getByTestId('tag-input'), { target: { value: 'новое' } });
    fireEvent.keyDown(screen.getByTestId('tag-input'), { key: 'Enter' });

    await waitFor(() =>
      expect(within(modal).getByTestId('tag-chip-новое')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(invoked('set_book_tags')).toHaveLength(1));
    const args = invoked('set_book_tags')[0].args as { uid: string; tags: string[] };
    expect(args.uid).toBe(book.uid);
    expect(args.tags.sort()).toEqual(['en', 'классика', 'новое'].sort());
  });

  it('routes "Stats" to the stats view', async () => {
    seed([makeBook({ title: 'Алиса' })]);
    render(<LibraryView />);

    fireEvent.click(screen.getByTestId('card-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stats' }));

    await waitFor(() => expect(useUiStore.getState().view).toBe('stats'));
  });

  it('starts the dialog-driven import flows from the header buttons', async () => {
    seed([]);
    const importSpy = vi.spyOn(useLibraryStore.getState(), 'importPaths').mockResolvedValue(null);
    const scanSpy = vi.spyOn(useLibraryStore.getState(), 'scanDir').mockResolvedValue(null);
    render(<LibraryView />);

    fireEvent.click(screen.getByTestId('empty-add'));
    expect(importSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('empty-scan'));
    expect(scanSpy).toHaveBeenCalled();

    importSpy.mockRestore();
    scanSpy.mockRestore();
  });

  it('shows the thin import bar while importing, determinate when progress arrives', () => {
    seed([makeBook()]);
    useLibraryStore.setState({ importing: true, importProgress: null });
    const { rerender } = render(<LibraryView />);

    const bar = screen.getByTestId('import-bar');
    expect(bar).toBeInTheDocument();
    expect(screen.getByTestId('import-bar-sweep')).toBeInTheDocument();

    useLibraryStore.setState({ importProgress: { done: 2, total: 8, current: '/b.epub' } });
    rerender(<LibraryView />);

    const fill = screen.getByTestId('import-bar-fill');
    expect(fill.style.width).toBe('25%');
    expect(bar).toHaveAttribute('aria-valuenow', '25');

    useLibraryStore.setState({ importing: false, importProgress: null });
    rerender(<LibraryView />);
    expect(screen.queryByTestId('import-bar')).not.toBeInTheDocument();
  });
});

// --------------------------------------------------------------------- drag&drop

describe('LibraryView drag & drop', () => {
  function dropPayload(file: File, withTypes = true) {
    return {
      dataTransfer: {
        files: [file],
        types: withTypes ? ['Files'] : [],
        dropEffect: 'none',
      },
    };
  }

  it('imports dropped .epub files when a real path is available', () => {
    seed([]);
    const spy = vi.spyOn(useLibraryStore.getState(), 'importPaths').mockResolvedValue(null);
    const { container } = render(<LibraryView />);

    const epub = new File([''], 'alice.epub', { type: 'application/epub+zip' });
    Object.defineProperty(epub, 'path', { value: '/books/alice.epub' });
    const txt = new File([''], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(txt, 'path', { value: '/books/notes.txt' });

    fireEvent.dragEnter(container.firstChild as HTMLElement, dropPayload(epub));
    expect(screen.getByTestId('drop-overlay')).toBeInTheDocument();

    fireEvent.drop(container.firstChild as HTMLElement, {
      dataTransfer: { files: [epub, txt], types: ['Files'], dropEffect: 'copy' },
    });

    expect(spy).toHaveBeenCalledWith(['/books/alice.epub']);   // .txt filtered out
    expect(screen.queryByTestId('drop-overlay')).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('hints the user when the webview exposes no file path (WebKitGTK limitation)', () => {
    seed([]);
    const spy = vi.spyOn(useLibraryStore.getState(), 'importPaths').mockResolvedValue(null);
    render(<LibraryView />);

    // No `path` property — exactly what WebKitGTK hands the DOM for a native file drop.
    const file = new File([''], 'alice.epub');
    fireEvent.drop(screen.getByTestId('library-view'), dropPayload(file));

    expect(spy).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.map((t) => t.msg))
      .toContain('Drag files again or use the button');
    spy.mockRestore();
  });

  it('ignores drops that carry no files', () => {
    seed([]);
    render(<LibraryView />);
    fireEvent.dragEnter(screen.getByTestId('library-view'), {
      dataTransfer: { files: [], types: ['text/plain'], dropEffect: 'none' },
    });
    expect(screen.queryByTestId('drop-overlay')).not.toBeInTheDocument();
  });
});
