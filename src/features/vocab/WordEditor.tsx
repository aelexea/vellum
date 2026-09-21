/**
 * WordEditor — [F4] per §5.8: Modal (480 px) to add/edit a vocab word.
 * word is read-only when editing an existing entry; "Save" → vocabStore.add /
 * vocabStore.update → toast "Done" (the store toasts on error itself).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { Segmented } from '@/components/Segmented';
import type { SegmentedOption } from '@/components/Segmented';
import { Select } from '@/components/Select';
import type { SelectOption } from '@/components/Select';
import type { VocabWord, VocabWordStatus } from '@/lib/types';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

export interface WordEditorProps {
  /** Existing word to edit; omitted/null → add mode. */
  word?: VocabWord | null;
  /** Prefill for add mode ("Add to vocabulary" flows, §5.7). */
  initialWord?: string;
  onClose: () => void;
}

const POS_OPTIONS: SelectOption[] = [
  { value: '', label: '—' },
  { value: 'n.', label: 'n.' },
  { value: 'v.', label: 'v.' },
  { value: 'adj.', label: 'adj.' },
  { value: 'adv.', label: 'adv.' },
  { value: 'other', label: 'other' },
];

const STATUS_OPTIONS: SegmentedOption<VocabWordStatus>[] = [
  { value: 'new', label: 'New' },
  { value: 'learning', label: 'Learning' },
  { value: 'known', label: 'Known' },
];

function Field({
  label, htmlFor, children,
}: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1" htmlFor={htmlFor}>
      <span className="text-[12px] font-medium text-[var(--v-fg-muted)]">{label}</span>
      {children}
    </label>
  );
}

export default function WordEditor({ word, initialWord = '', onClose }: WordEditorProps) {
  const existing = word ?? null;

  const [wordText, setWordText] = useState(existing?.word ?? initialWord);
  const [translation, setTranslation] = useState(existing?.translation ?? '');
  const [definition, setDefinition] = useState(existing?.definition ?? '');
  const [transcription, setTranscription] = useState(existing?.transcription ?? '');
  const [pos, setPos] = useState(existing?.pos ?? '');
  const [examples, setExamples] = useState<string[]>(
    existing && existing.examples.length > 0 ? existing.examples : [''],
  );
  const [context, setContext] = useState(existing?.context ?? '');
  const [status, setStatus] = useState<VocabWordStatus>(existing?.status ?? 'new');
  const [saving, setSaving] = useState(false);

  const trim = (s: string): string | null => {
    const t = s.trim();
    return t === '' ? null : t;
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const vocab = useVocabStore.getState();
    const cleanExamples = examples.map((e) => e.trim()).filter((e) => e !== '');
    setSaving(true);
    try {
      if (existing) {
        await vocab.update(existing.id, {
          translation: trim(translation),
          definition: trim(definition),
          transcription: trim(transcription),
          pos: trim(pos),
          examples: cleanExamples,
          status,
          context: trim(context),
        });
      } else {
        const w = trim(wordText);
        if (!w) {
          setSaving(false);
          return;
        }
        await vocab.add({
          word: w,
          translation: trim(translation),
          definition: trim(definition),
          transcription: trim(transcription),
          pos: trim(pos),
          examples: cleanExamples,
          context: trim(context),
          status,
        });
      }
      useUiStore.getState().toast('Done', 'success');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const canSave = existing ? true : wordText.trim() !== '';

  return (
    <Modal
      onClose={onClose}
      title={existing ? 'Edit word' : 'Add to vocabulary'}
      widthClass="max-w-[480px]"
      footer={(
        <>
          <button type="button" className="vellum-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="vellum-btn vellum-btn-accent"
            onClick={() => void save()}
            disabled={saving || !canSave}
          >
            Save
          </button>
        </>
      )}
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
        <Field label="Word" htmlFor="we-word">
          <input
            id="we-word"
            type="text"
            value={wordText}
            readOnly={existing !== null}
            onChange={(e) => setWordText(e.target.value)}
            className={existing ? 'text-[15px] font-semibold opacity-60' : 'text-[15px] font-semibold'}
            autoFocus={existing === null}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Translation" htmlFor="we-translation">
            <input
              id="we-translation"
              type="text"
              value={translation}
              onChange={(e) => setTranslation(e.target.value)}
            />
          </Field>
          <Field label="Transcription" htmlFor="we-transcription">
            <input
              id="we-transcription"
              type="text"
              value={transcription}
              onChange={(e) => setTranscription(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Definition">
          <textarea
            rows={2}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            className="resize-none"
          />
        </Field>

        <div className="grid grid-cols-2 items-start gap-3">
          <Field label="Part of speech">
            <Select
              options={POS_OPTIONS}
              value={pos}
              onChange={setPos}
              ariaLabel="Part of speech"
            />
          </Field>
          <Field label="Status">
            <Segmented
              options={STATUS_OPTIONS}
              value={status}
              onChange={setStatus}
              ariaLabel="Word status"
              size="sm"
              className="w-full justify-between"
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-[var(--v-fg-muted)]">Examples</span>
            <button
              type="button"
              className="vellum-btn h-7 gap-1 text-[12px]"
              onClick={() => setExamples((ex) => [...ex, ''])}
            >
              <Icon name="plus" size={12} />
              Add
            </button>
          </div>
          {examples.map((ex, i) => (
            // eslint-disable-next-line react/no-array-index-key -- positional editor rows
            <div key={i} className="flex items-start gap-1.5">
              <textarea
                rows={2}
                value={ex}
                aria-label={`Example ${i + 1}`}
                onChange={(e) =>
                  setExamples((list) => list.map((v, j) => (j === i ? e.target.value : v)))}
                className="min-w-0 flex-1 resize-none text-[13px]"
                placeholder="A sentence with this word…"
              />
              <button
                type="button"
                className="vellum-icon-btn h-8 w-8 shrink-0"
                aria-label={`Delete example ${i + 1}`}
                onClick={() => setExamples((list) => list.filter((_, j) => j !== i))}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>

        <Field label="Context">
          <textarea
            rows={2}
            value={context}
            readOnly={existing !== null}
            onChange={(e) => setContext(e.target.value)}
            className={existing ? 'resize-none text-[13px] italic opacity-60' : 'resize-none text-[13px] italic'}
            placeholder="The sentence where the word appeared"
          />
        </Field>
      </div>
    </Modal>
  );
}
