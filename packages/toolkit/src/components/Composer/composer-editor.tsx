/**
 * The composer's text box: a CodeMirror editor over plain markdown text. The
 * document is exactly the text sent; formatting is decoration only. Markers
 * (backticks, asterisks, fences) are hidden until the caret is in their span,
 * code blocks are drawn like a sent message's, and fenced code is highlighted
 * with the language's parser, loaded only when a fence names it.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  type Range,
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import {
  HighlightStyle,
  Language,
  LanguageDescription,
  ParseContext,
  defineLanguageFacet,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { parser as markdownParser, parseCode } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';
import { guessLanguage } from './guess-language.js';

/** What the Composer reads and moves, in the textarea's terms: offsets into the text. */
export interface ComposerInputHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
}

export interface ComposerEditorProps {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  maxHeight: number;
  /** A change the person made (not one from `value`), with the caret after it. */
  onChange: (value: string, cursor: number) => void;
  /** Return true when the key was handled. */
  onKeyDown?: (e: KeyboardEvent) => boolean;
  /** Return true when the paste was handled; `at` is where it would go. */
  onPaste?: (e: ClipboardEvent, at: number) => boolean;
  onFocus?: () => void;
}

// ── Markdown, with fenced code parsed by the language its fence names ──

const findLanguage = (tag: string) => LanguageDescription.matchLanguageName(languages, tag, true);

const markdownLanguage = new Language(
  defineLanguageFacet(),
  markdownParser.configure(
    parseCode({
      codeParser: (info) => {
        const description = findLanguage(info);
        if (!description) return null;
        if (description.support) return description.support.language.parser;
        // Parse as plain text until the language loads, then again with it.
        return ParseContext.getSkippingParser(description.load());
      },
    }),
  ),
  [],
  'markdown',
);

/** The same colours as code in a sent message (shiki's github-dark-default). */
const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: '#ff7b72' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: '#a5d6ff' },
  { tag: [t.lineComment, t.blockComment, t.docComment], color: '#8b949e' },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName), t.standard(t.variableName)], color: '#79c0ff' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: '#d2a8ff' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: '#ffa657' },
  { tag: [t.tagName], color: '#7ee787' },
  { tag: [t.attributeName], color: '#79c0ff' },
  { tag: [t.inserted], color: '#aff5b4' },
  { tag: [t.deleted], color: '#ffdcd7' },
]);

// ── Guessed languages for fences that name none ──
// Keyed by where the block starts; guessed again only when typing pauses.

const setGuesses = StateEffect.define<Map<number, string>>();
const guesses = StateField.define<Map<number, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setGuesses)) return effect.value;
    if (!tr.docChanged) return value;
    const moved = new Map<number, string>();
    value.forEach((name, at) => moved.set(tr.changes.mapPos(at), name));
    return moved;
  },
});

function guessAll(state: EditorState): Map<number, string> {
  const found = new Map<number, string>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      if (!node.node.getChild('CodeInfo')) {
        const text = node.node.getChild('CodeText');
        const name = text ? guessLanguage(state.doc.sliceString(text.from, text.to)) : null;
        if (name) found.set(node.from, name);
      }
      return false;
    },
  });
  return found;
}

const GUESS_IDLE_MS = 600;
const guessWhenIdle = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(u: { docChanged: boolean }) {
      if (u.docChanged) this.schedule();
    }
    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const next = guessAll(this.view.state);
        const current = this.view.state.field(guesses);
        const same = next.size === current.size && [...next].every(([at, name]) => current.get(at) === name);
        if (!same) this.view.dispatch({ effects: setGuesses.of(next) });
      }, GUESS_IDLE_MS);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

// ── Decorations ──

const hideMark = Decoration.replace({});
const liveMark = Decoration.mark({ class: 'cm-md-mark' });
const codeMark = Decoration.mark({ class: 'cm-md-code' });
const strongMark = Decoration.mark({ class: 'cm-md-strong' });
const emMark = Decoration.mark({ class: 'cm-md-em' });
const fenceMark = Decoration.mark({ class: 'cm-md-fence-mark' });

/** The block's language label: the full name, a guess (fainter), or "Code". */
class LanguageLabel extends WidgetType {
  constructor(readonly name: string, readonly guessed: boolean) {
    super();
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.guessed ? 'cm-md-fence-label cm-md-fence-label-guess' : 'cm-md-fence-label';
    el.textContent = this.name;
    if (this.guessed) el.title = 'Guessed from the code';
    return el;
  }
  eq(other: LanguageLabel) {
    return other.name === this.name && other.guessed === this.guessed;
  }
}

/** Room above and below a code block; a block widget, since lines can't take vertical margins. */
class Gap extends WidgetType {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-md-fence-gap';
    return el;
  }
  eq() {
    return true;
  }
}
const gapBefore = Decoration.widget({ widget: new Gap(), block: true, side: -1 });
const gapAfter = Decoration.widget({ widget: new Gap(), block: true, side: 1 });

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const sel = state.selection.main;
  const touches = (from: number, to: number) => sel.from <= to && sel.to >= from;
  const doc = state.doc;
  const caretLine = doc.lineAt(sel.head).number;
  const guessed = state.field(guesses);

  syntaxTree(state).iterate({
    enter: (node) => {
      const marker = (from: number, to: number) => {
        if (from < to) ranges.push((touches(node.from, node.to) ? liveMark : hideMark).range(from, to));
      };
      if (node.name === 'InlineCode') {
        ranges.push(codeMark.range(node.from, node.to));
        node.node.getChildren('CodeMark').forEach((m) => marker(m.from, m.to));
        return false;
      }
      if (node.name === 'StrongEmphasis' || node.name === 'Emphasis') {
        ranges.push((node.name === 'StrongEmphasis' ? strongMark : emMark).range(node.from, node.to));
        node.node.getChildren('EmphasisMark').forEach((m) => marker(m.from, m.to));
        return;
      }
      if (node.name !== 'FencedCode') return;

      const first = doc.lineAt(node.from).number;
      const last = doc.lineAt(node.to).number;
      const marks = node.node.getChildren('CodeMark');
      const closed = marks.length > 1 && last > first;
      const editingHead = caretLine === first;
      const editingFoot = closed && caretLine === last;
      ranges.push(gapBefore.range(doc.line(first).from), gapAfter.range(doc.line(last).to));
      for (let n = first; n <= last; n++) {
        const cls = ['cm-md-fence'];
        if (n === first) cls.push('cm-md-fence-head', editingHead ? 'cm-md-fence-editing' : 'cm-md-fence-resting');
        if (n === last) cls.push('cm-md-fence-last');
        if (closed && n === last) cls.push('cm-md-fence-foot', editingFoot ? 'cm-md-fence-editing' : 'cm-md-fence-resting');
        ranges.push(Decoration.line({ class: cls.join(' ') }).range(doc.line(n).from));
      }
      // A fence line shows its raw text, small and faint, only while the caret is on it.
      marks.forEach((m) => {
        const onLine = doc.lineAt(m.from).number === caretLine;
        ranges.push((onLine ? fenceMark : hideMark).range(m.from, m.to));
      });
      const info = node.node.getChild('CodeInfo');
      if (editingHead) {
        if (info) ranges.push(fenceMark.range(info.from, info.to));
      } else if (info) {
        const tag = doc.sliceString(info.from, info.to);
        const name = findLanguage(tag)?.name ?? tag;
        ranges.push(Decoration.replace({ widget: new LanguageLabel(name, false) }).range(info.from, info.to));
      } else {
        const at = marks[0]?.to ?? node.from;
        const guess = guessed.get(node.from);
        ranges.push(Decoration.widget({ widget: new LanguageLabel(guess ?? 'Code', !!guess), side: 1 }).range(at));
      }
      return false;
    },
  });

  const builder = new RangeSetBuilder<Decoration>();
  ranges
    .sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
    .forEach((r) => builder.add(r.from, r.to, r.value));
  return builder.finish();
}

// A state field, not a view plugin: the gaps are block decorations.
const markdownDecorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  update: (deco, tr) =>
    tr.docChanged
    || tr.selection
    || tr.effects.some((e) => e.is(setGuesses))
    || syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ? buildDecorations(tr.state)
      : deco,
  provide: (f) => EditorView.decorations.from(f),
});

// ── Look ──

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
const LINE = '1px solid var(--color-line, rgba(255,255,255,0.08))';

const theme = EditorView.theme({
  '&': { color: 'var(--color-composer-text)', fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.625', overflow: 'auto' },
  '.cm-content': { padding: '12px 0 4px', caretColor: 'var(--foreground, currentColor)' },
  '.cm-line': { padding: '0 14px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground, currentColor)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(34, 211, 238, 0.25)',
  },
  '.cm-md-mark': { color: 'var(--color-composer-text-faint)' },
  '.cm-md-strong': { fontWeight: '600' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-code': {
    fontFamily: MONO,
    fontSize: '0.9em',
    background: 'var(--color-surface-2, rgba(255,255,255,0.08))',
    padding: '0.1em 0.35em',
    borderRadius: '4px',
  },
  // The lines of a fenced block together draw a sent message's code block.
  '.cm-line.cm-md-fence': {
    fontFamily: MONO,
    fontSize: '12px',
    color: '#e6edf3',
    background: 'var(--color-bg, #1c1917)',
    borderLeft: LINE,
    borderRight: LINE,
    margin: '0 14px',
    padding: '0 12px',
  },
  '.cm-line.cm-md-fence-head': {
    borderTop: LINE,
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
    paddingTop: '6px',
    fontSize: '11px',
    lineHeight: '1.8',
  },
  '.cm-line.cm-md-fence-last': {
    borderBottom: LINE,
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
    paddingBottom: '6px',
  },
  // The closing fence: a slim bottom edge until the caret is on it.
  '.cm-line.cm-md-fence-foot': { fontSize: '11px', lineHeight: '1.8' },
  '.cm-line.cm-md-fence-foot.cm-md-fence-resting': { fontSize: '4px', lineHeight: '1' },
  '.cm-md-fence-mark': { color: 'var(--color-composer-text-faint)' },
  '.cm-md-fence-label': {
    fontFamily: 'var(--font-sans, inherit)',
    color: 'var(--color-composer-text-secondary)',
  },
  '.cm-md-fence-label-guess': { color: 'var(--color-composer-text-faint)' },
  '.cm-md-fence-gap': { height: '6px' },
  // At rest the label sits in the block's top-right corner; the raw fence line edits from the left.
  '.cm-line.cm-md-fence-head.cm-md-fence-resting': { textAlign: 'right' },
});

// Enter belongs to the Composer (send); Shift+Enter is a plain line break, as in a textarea.
const editorKeymap = [
  { key: 'Shift-Enter', run: insertNewline },
  ...defaultKeymap.filter((binding) => binding.key !== 'Enter'),
  ...historyKeymap,
];

/** Marks a change that came from `value`, so it is not reported back as typing. */
const fromValue = Transaction.userEvent.of('composer.value');

export const ComposerEditor = forwardRef<ComposerInputHandle, ComposerEditorProps>(function ComposerEditor(
  { value, placeholder, disabled = false, maxHeight, onChange, onKeyDown, onPaste, onFocus },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment()).current;
  const handlers = useRef({ onChange, onKeyDown, onPaste, onFocus });
  handlers.current = { onChange, onKeyDown, onPaste, onFocus };

  useImperativeHandle(ref, () => ({
    get value() {
      return viewRef.current?.state.doc.toString() ?? value;
    },
    get selectionStart() {
      return viewRef.current?.state.selection.main.from ?? 0;
    },
    get selectionEnd() {
      return viewRef.current?.state.selection.main.to ?? 0;
    },
    setSelectionRange(start: number, end: number) {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      view.dispatch({
        selection: EditorSelection.range(Math.min(start, length), Math.min(end, length)),
        scrollIntoView: true,
      });
    },
    focus() {
      viewRef.current?.focus();
    },
  }));

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of(editorKeymap),
          markdownLanguage,
          syntaxHighlighting(codeHighlight),
          guesses,
          guessWhenIdle,
          markdownDecorations,
          EditorView.lineWrapping,
          editable.of(EditorView.editable.of(!disabled)),
          EditorView.contentAttributes.of({
            'data-testid': 'composer-input',
            'aria-label': placeholder || 'Message',
            'aria-multiline': 'true',
            // The textarea's defaults: a prose box, so spelling and phone autocorrect stay on.
            spellcheck: 'true',
            autocorrect: 'on',
            autocapitalize: 'sentences',
          }),
          theme,
          EditorView.theme({ '.cm-scroller': { maxHeight: `${maxHeight}px` } }),
          // Ahead of the keymap: the Composer's keys (send, menu navigation) come first.
          Prec.highest(EditorView.domEventHandlers({
            keydown: (e, v) => {
              // Enter that confirms an IME candidate is the IME's, not a send.
              if (e.isComposing || v.composing) return false;
              return handlers.current.onKeyDown?.(e) ?? false;
            },
            paste: (e, v) => handlers.current.onPaste?.(e, v.state.selection.main.from) ?? false,
            focus: () => {
              handlers.current.onFocus?.();
              return false;
            },
          })),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.every((tr) => !tr.docChanged || tr.isUserEvent('composer.value'))) return;
            handlers.current.onChange(u.state.doc.toString(), u.state.selection.main.head);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is made once; later prop changes reach it through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new `value` from outside (send clears it, an emoji pick, an inserted note,
  // a draft restored): change only the stretch that differs, so the caret and
  // the rest of the text stay put.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start]) start++;
    let end = 0;
    while (
      end < current.length - start
      && end < value.length - start
      && current[current.length - 1 - end] === value[value.length - 1 - end]
    ) end++;
    view.dispatch({
      changes: { from: start, to: current.length - end, insert: value.slice(start, value.length - end) },
      annotations: [fromValue, Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!disabled)) });
  }, [disabled, editable]);

  return (
    <div className="relative w-full min-h-[40px]">
      {value === '' && placeholder && (
        // Drawn outside the editable text, so an empty box holds no text.
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 px-3.5 pt-3 text-sm leading-relaxed text-composer-text-faint"
        >
          {placeholder}
        </div>
      )}
      <div ref={hostRef} />
    </div>
  );
});
