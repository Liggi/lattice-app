import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Send, Loader2, Square, X, FileText, ChevronUp, ChevronDown, Paperclip, Image, Plus, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/tooltip.js';
import { cn } from '../../utils/cn.js';
import { storage } from '../../utils/storage.js';
import { useLocalStorage } from '../../hooks/useLocalStorage.js';
import { useAttachments } from '../../hooks/useAttachments.js';
import { AutocompleteDropdown } from './AutocompleteDropdown.js';
import type { ComposerProps, ComposerRef, FileSystemEntry, Command, EmojiSuggestion } from './types.js';

interface AutocompleteState {
  isActive: boolean;
  triggerIndex: number;
  query: string;
  suggestions: FileSystemEntry[] | Command[] | EmojiSuggestion[];
  focusedIndex: number;
  type: 'file' | 'command' | 'emoji';
}

// `:` at the start or after anything but a letter, digit or colon (so not in
// `10:30` or `http://`, but straight after another emoji), then the name typed
// so far. Two characters before the list opens, as in Slack, so a lone colon
// or a smiley like `:)` never pops it.
const EMOJI_QUERY = /(^|[^a-z0-9_:])(:([a-z0-9_+-]{2,}))$/i;
// The same, closed with a second colon: `:tada:` becomes 🎉 as it is typed.
const EMOJI_COMPLETE = /(^|[^a-z0-9_:])(:([a-z0-9_+-]+):)$/i;

// Per-session draft storage key
const getDraftStorageKey = (sessionId?: string) =>
  sessionId ? `composer-draft-${sessionId}` : 'composer-draft-home';

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

function formatModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// Textarea auto-grow cap: 3 rows of text.
// text-sm (14px) x leading-relaxed (1.625) = 22.75px per row; py-2 adds 16px of
// vertical padding. 3 x 22.75 + 16 = 84.25 -> 85 avoids sub-pixel clipping of row 3.
// Single source of truth: used by the JS clamp AND applied inline as max-height,
// so there is no Tailwind max-h class to drift out of sync.
const TEXTAREA_MAX_HEIGHT_PX = 85;

/*
 * Touch targets.
 *
 * The composer's icon buttons are deliberately 32px so the bar stays dense, but
 * 32px is below the 44x44 minimum in Apple's HIG and WCAG 2.5.5. These classes
 * keep the 32px visual box and grow only the *tappable* area, using a centred
 * absolutely-positioned pseudo-element. Because it is out of flow, nothing
 * reflows — the button occupies exactly the same space it did before.
 *
 * `w-full` + `min-w-11` means "at least 44px wide, but never narrower than the
 * button itself", so it also fits the wider Stop button in its "Stopping" state.
 */
const TOUCH_TARGET_44 =
  "relative before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 " +
  "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/*
 * Smaller variant for the attachment chip's remove button. The chip is only
 * ~26px tall, so a 44px target would spill past the chip strip and turn taps on
 * the textarea below it into "remove attachment" — a destructive misfire. 32x32
 * quadruples the tappable area while staying inside the strip.
 */
const TOUCH_TARGET_32 =
  "relative before:absolute before:top-1/2 before:left-1/2 before:h-8 before:w-8 " +
  "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

const ACCEPTED_FILE_TYPES =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,text/html,text/css,text/javascript,application/json,application/xml,text/xml,.json,.md,.txt,.csv,.html,.css,.js,.ts,.yaml,.yml';

export const Composer = forwardRef<ComposerRef, ComposerProps>(function Composer(
  props: ComposerProps,
  ref: React.Ref<ComposerRef>,
) {
  const onSubmit = props.core?.onSubmit ?? (() => {});
  const controlledValue = props.core?.value;
  const onControlledChange = props.core?.onChange;
  const placeholder = props.core?.placeholder ?? 'Type a message...';
  const disabled = props.core?.disabled ?? false;
  const sessionId = props.core?.sessionId;
  const allowEmptySubmit = props.core?.allowEmptySubmit ?? false;

  const enableAttachments = props.features?.enableAttachments ?? true;
  const enableFileAutocomplete = props.features?.enableFileAutocomplete ?? false;
  const showStatusBar = props.features?.showStatusBar ?? true;
  const showMenu = props.features?.showMenu ?? false;

  const workingDirectory = props.workingDirectory ?? '';
  const onStop = props.permissionConfig?.onStop;
  const onInterrupt = props.permissionConfig?.onInterrupt;
  const renderStatusExtra = props.renderStatusExtra;
  const renderActionsExtra = props.renderActionsExtra;
  const renderLeadingActions = props.renderLeadingActions;
  const searchEmoji = props.searchEmoji;

  const isSessionActive = props.runtimeConfig?.isSessionActive ?? false;
  const isSessionConnected = props.runtimeConfig?.isSessionConnected ?? isSessionActive;
  const isStopRequested = props.runtimeConfig?.isStopRequested ?? false;
  const isInitializing = props.runtimeConfig?.isInitializing ?? false;
  const isCompacting = props.runtimeConfig?.isCompacting ?? false;
  const hasBackgroundTasks = props.runtimeConfig?.hasBackgroundTasks ?? false;
  const backgroundTaskLabel =
    props.runtimeConfig?.backgroundTaskLabel ?? 'Waiting for background task';
  const sessionStartTime = props.runtimeConfig?.sessionStartTime;
  const fileSystemEntries = props.runtimeConfig?.fileSystemEntries ?? [];
  const onFetchFileSystem = props.runtimeConfig?.onFetchFileSystem;
  const availableCommands = props.runtimeConfig?.availableCommands ?? [];
  const onFetchCommands = props.runtimeConfig?.onFetchCommands;
  const queuedMessages = props.runtimeConfig?.queuedMessages ?? [];
  const sessionUsage = props.runtimeConfig?.sessionUsage ?? null;
  const sessionModel = props.runtimeConfig?.sessionModel ?? null;
  const sessionModelFallback = props.runtimeConfig?.sessionModelFallback ?? false;
  const availableModels = props.runtimeConfig?.availableModels ?? [];
  const selectedModel = props.runtimeConfig?.selectedModel ?? null;
  const onModelChange = props.runtimeConfig?.onModelChange;
  const isModelSelectorEnabled = availableModels.length > 0 && !!onModelChange;
  const defaultModel = availableModels.find((m) => m.isDefault);
  const effectiveModel = selectedModel
    ? availableModels.find((m) => m.id === selectedModel)
    : defaultModel;

  const availableEfforts = props.runtimeConfig?.availableEfforts ?? [];
  const selectedEffort = props.runtimeConfig?.selectedEffort ?? null;
  const onEffortChange = props.runtimeConfig?.onEffortChange;
  const effortProvided = availableEfforts.length > 0;
  const isEffortSelectorEnabled = effortProvided && isModelSelectorEnabled;
  const defaultEffort = availableEfforts.find((e) => e.isDefault);
  const effectiveEffort = selectedEffort
    ? availableEfforts.find((e) => e.id === selectedEffort)
    : defaultEffort;
  // Show the effort label on the badge only when a non-default effort is active.
  const badgeEffortLabel =
    isEffortSelectorEnabled && effectiveEffort && !effectiveEffort.isDefault
      ? effectiveEffort.label
      : null;

  // ── Status derivation ──

  const currentStatus = isInitializing
    ? 'Starting'
    : isStopRequested
      ? 'Stopping'
      : isCompacting
        ? 'Compacting context'
      : isSessionActive
        ? 'Working'
        : hasBackgroundTasks && isSessionConnected
          ? backgroundTaskLabel
          : isSessionConnected
            ? 'Ready'
            : 'Off';

  const prevStatusRef = useRef(currentStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = currentStatus;
    if (prev === currentStatus) return;
    if (prev === 'Ready' && currentStatus === 'Starting') {
      console.error(
        `[Composer] ILLEGAL STATUS TRANSITION: ${prev} → ${currentStatus}. ` +
          `Ready means the process is alive, Starting means starting a new one.\n` +
          `  isSessionActive=${isSessionActive}, isSessionConnected=${isSessionConnected}, ` +
          `isInitializing=${isInitializing}, isStopRequested=${isStopRequested}`,
      );
    }
  }, [currentStatus, isSessionActive, isSessionConnected, isInitializing, isStopRequested]);

  // ── Attachments ──

  const {
    attachments,
    addFiles,
    removeAttachment,
    clearAll: clearAttachments,
    getContentBlocks,
    isProcessing: isProcessingAttachments,
    hasAttachments,
    error: attachmentError,
  } = useAttachments();

  // ── Draft persistence ──

  const draftStorageKey = getDraftStorageKey(sessionId);
  const [storedDraft, setStoredDraft] = useLocalStorage<string>(draftStorageKey, '');

  const [uncontrolledValue, setUncontrolledValue] = useState(storedDraft);
  const value = controlledValue !== undefined ? controlledValue : uncontrolledValue;
  const setValue = (newValue: string) => {
    if (controlledValue === undefined) setUncontrolledValue(newValue);
    onControlledChange?.(newValue);
  };

  useEffect(() => {
    if (controlledValue === undefined) setStoredDraft(uncontrolledValue);
  }, [uncontrolledValue, setStoredDraft, controlledValue]);

  useEffect(() => {
    if (controlledValue === undefined) setUncontrolledValue(storedDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftStorageKey]);

  // ── Local state ──

  const [localFileSystemEntries, setLocalFileSystemEntries] = useState<FileSystemEntry[]>([]);
  const [localCommands, setLocalCommands] = useState<Command[]>([]);
  const effectiveFileSystemEntries =
    localFileSystemEntries.length > 0 ? localFileSystemEntries : fileSystemEntries;
  const effectiveCommands = localCommands.length > 0 ? localCommands : availableCommands;

  const [autocomplete, setAutocomplete] = useState<AutocompleteState>({
    isActive: false,
    triggerIndex: -1,
    query: '',
    suggestions: [],
    focusedIndex: -1,
    type: 'file',
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileSystemFetchInFlightRef = useRef<Promise<FileSystemEntry[]> | null>(null);
  const commandsFetchInFlightRef = useRef<Promise<Command[]> | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  // True while the foot's badge strip has more to scroll to on its right.
  const [badgesClipped, setBadgesClipped] = useState(false);
  const badgesElRef = useRef<HTMLDivElement | null>(null);
  const badgesObserverRef = useRef<ResizeObserver | null>(null);
  const measureBadges = useCallback((el: HTMLElement) => {
    setBadgesClipped(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);
  const badgesRef = useCallback((el: HTMLDivElement | null) => {
    badgesObserverRef.current?.disconnect();
    badgesObserverRef.current = null;
    badgesElRef.current = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measureBadges(el));
    observer.observe(el);
    badgesObserverRef.current = observer;
  }, [measureBadges]);
  // A badge appearing inside an already-full strip does not resize the strip,
  // so re-measure after every render as well.
  useEffect(() => {
    if (badgesElRef.current) measureBadges(badgesElRef.current);
  });
  const modelMenuListRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const [modelMenuFocusIndex, setModelMenuFocusIndex] = useState(-1);

  // ── Elapsed time ──

  const [elapsedTime, setElapsedTime] = useState<string>('0:00');
  const [hasSessionStartTime, setHasSessionStartTime] = useState(false);

  useEffect(() => {
    setLocalFileSystemEntries([]);
    setLocalCommands([]);
    fileSystemFetchInFlightRef.current = null;
    commandsFetchInFlightRef.current = null;
  }, [workingDirectory]);

  const isSessionAlive = isSessionActive || isSessionConnected;
  useEffect(() => {
    if (!isSessionAlive) {
      setElapsedTime('0:00');
      setHasSessionStartTime(false);
      return;
    }
    if (!sessionStartTime) {
      setHasSessionStartTime(false);
      return;
    }

    setHasSessionStartTime(true);
    const updateElapsed = () => {
      const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      setElapsedTime(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [isSessionAlive, sessionStartTime]);

  // ── Model selector dismissal ──

  const closeModelMenu = useCallback((returnFocus: boolean) => {
    setIsModelMenuOpen(false);
    setModelMenuFocusIndex(-1);
    if (returnFocus) modelTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isModelMenuOpen) return;
    const handlePointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        modelMenuRef.current?.contains(target) ||
        modelMenuListRef.current?.contains(target)
      ) {
        return;
      }
      closeModelMenu(false);
    };
    document.addEventListener('pointerdown', handlePointer);
    return () => document.removeEventListener('pointerdown', handlePointer);
  }, [isModelMenuOpen, closeModelMenu]);

  // Flat list of every selectable row across both sections, so roving focus and
  // keyboard nav span "Model" + "Reasoning" as one list. Effort rows are only
  // present when the effort props are provided.
  const menuRows: Array<
    | { kind: 'model'; id: string; isDefault?: boolean }
    | { kind: 'effort'; id: string; isDefault?: boolean }
  > = [
    ...availableModels.map((m) => ({ kind: 'model' as const, id: m.id, isDefault: m.isDefault })),
    ...(isEffortSelectorEnabled
      ? availableEfforts.map((eff) => ({ kind: 'effort' as const, id: eff.id, isDefault: eff.isDefault }))
      : []),
  ];

  // Activate a row: choosing a model closes the menu (returning focus to the
  // trigger); choosing an effort keeps the menu open (users often set both).
  const activateMenuRow = useCallback(
    (row: { kind: 'model' | 'effort'; id: string; isDefault?: boolean }) => {
      if (row.kind === 'model') {
        onModelChange?.(row.isDefault ? null : row.id);
        closeModelMenu(true);
      } else {
        onEffortChange?.(row.isDefault ? null : row.id);
      }
    },
    [onModelChange, onEffortChange, closeModelMenu],
  );

  // Open the menu focused on the effective model's row.
  useEffect(() => {
    if (!isModelMenuOpen) return;
    const idx = availableModels.findIndex((m) => m.id === (effectiveModel?.id ?? null));
    setModelMenuFocusIndex(idx >= 0 ? idx : 0);
  }, [isModelMenuOpen, availableModels, effectiveModel]);

  // Move DOM focus onto the active row as it changes.
  useEffect(() => {
    if (!isModelMenuOpen || modelMenuFocusIndex < 0 || !modelMenuListRef.current) return;
    const items = modelMenuListRef.current.querySelectorAll<HTMLElement>('[data-menu-option]');
    items[modelMenuFocusIndex]?.focus();
  }, [isModelMenuOpen, modelMenuFocusIndex]);

  const handleModelMenuKeyDown = (e: React.KeyboardEvent) => {
    const count = menuRows.length;
    if (count === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setModelMenuFocusIndex((i) => (i < 0 ? 0 : (i + 1) % count));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setModelMenuFocusIndex((i) => (i <= 0 ? count - 1 : i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setModelMenuFocusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setModelMenuFocusIndex(count - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (modelMenuFocusIndex >= 0) activateMenuRow(menuRows[modelMenuFocusIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        closeModelMenu(true);
        break;
    }
  };

  // ── Ref ──

  useImperativeHandle(ref, () => ({
    focusInput: () => textareaRef.current?.focus(),
    insertText: (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      setValue(textarea.value.substring(0, start) + text + textarea.value.substring(end));
      resetAutocomplete();
      placeCaret(start + text.length);
    },
  }));

  // ── Fetch helpers ──

  const fetchFileSystemEntries = useCallback(async (): Promise<FileSystemEntry[]> => {
    if (!enableFileAutocomplete || !onFetchFileSystem) return [];
    if (!workingDirectory || workingDirectory === 'Select directory') return [];
    if (fileSystemFetchInFlightRef.current) return fileSystemFetchInFlightRef.current;

    const request = onFetchFileSystem(workingDirectory)
      .then((entries) => {
        setLocalFileSystemEntries(entries);
        return entries;
      })
      .catch((error) => {
        console.error('Failed to fetch file system entries:', error);
        return [];
      })
      .finally(() => {
        fileSystemFetchInFlightRef.current = null;
      });

    fileSystemFetchInFlightRef.current = request;
    return request;
  }, [enableFileAutocomplete, onFetchFileSystem, workingDirectory]);

  const fetchCommands = useCallback(async (): Promise<Command[]> => {
    if (!onFetchCommands) return [];
    if (commandsFetchInFlightRef.current) return commandsFetchInFlightRef.current;

    const request = onFetchCommands(
      workingDirectory !== 'Select directory' ? workingDirectory : undefined,
    )
      .then((commands) => {
        setLocalCommands(commands);
        return commands;
      })
      .catch((error) => {
        console.error('Failed to fetch commands:', error);
        return [];
      })
      .finally(() => {
        commandsFetchInFlightRef.current = null;
      });

    commandsFetchInFlightRef.current = request;
    return request;
  }, [onFetchCommands, workingDirectory]);

  // Fetch on focus
  useEffect(() => {
    if (!enableFileAutocomplete || !onFetchFileSystem) return;
    const textarea = textareaRef.current;
    if (textarea) {
      const handleFocus = () => void fetchFileSystemEntries();
      textarea.addEventListener('focus', handleFocus);
      return () => textarea.removeEventListener('focus', handleFocus);
    }
  }, [enableFileAutocomplete, onFetchFileSystem, fetchFileSystemEntries]);

  useEffect(() => {
    if (!onFetchCommands) return;
    const textarea = textareaRef.current;
    if (textarea) {
      const handleFocus = () => void fetchCommands();
      textarea.addEventListener('focus', handleFocus);
      return () => textarea.removeEventListener('focus', handleFocus);
    }
  }, [onFetchCommands, fetchCommands]);

  // ── Autocomplete ──

  const detectAutocomplete = (val: string, cursorPosition: number) => {
    const beforeCursor = val.substring(0, cursorPosition);
    const lastAtIndex = beforeCursor.lastIndexOf('@');
    if (lastAtIndex === -1) return null;

    const afterAt = beforeCursor.substring(lastAtIndex + 1);
    if (afterAt.includes(' ') || afterAt.includes('\n')) return null;

    return { triggerIndex: lastAtIndex, query: afterAt, type: 'file' as const };
  };

  const detectSlashCommandAutocomplete = (val: string, cursorPosition: number) => {
    const beforeCursor = val.substring(0, cursorPosition);
    const lastSlashIndex = beforeCursor.lastIndexOf('/');
    if (lastSlashIndex === -1) return null;

    const beforeSlash = beforeCursor.substring(0, lastSlashIndex);
    if (beforeSlash.trim() !== '' && !beforeSlash.endsWith('\n') && !beforeSlash.endsWith(' '))
      return null;

    const afterSlash = beforeCursor.substring(lastSlashIndex + 1);
    if (afterSlash.includes(' ') || afterSlash.includes('\n')) return null;

    return { triggerIndex: lastSlashIndex, query: afterSlash, type: 'command' as const };
  };

  const detectEmojiAutocomplete = (val: string, cursorPosition: number) => {
    if (!searchEmoji) return null;
    const match = EMOJI_QUERY.exec(val.substring(0, cursorPosition));
    if (!match) return null;
    return {
      triggerIndex: cursorPosition - match[2].length,
      query: match[3],
      type: 'emoji' as const,
    };
  };

  /** A just-closed `:name:` whose name is an exact shortcode, as the emoji. */
  const completedEmoji = (val: string, cursorPosition: number) => {
    if (!searchEmoji) return null;
    const match = EMOJI_COMPLETE.exec(val.substring(0, cursorPosition));
    if (!match) return null;
    const name = match[3].toLowerCase();
    const hit = searchEmoji(name).find((s) => s.shortcode.toLowerCase() === name);
    return hit ? { start: cursorPosition - match[2].length, emoji: hit.emoji } : null;
  };

  const placeCaret = (position: number) => {
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.setSelectionRange(position, position);
        textareaRef.current.focus();
        adjustTextareaHeight();
      }
    }, 0);
  };

  const filterSuggestions = (query: string): FileSystemEntry[] => {
    if (!effectiveFileSystemEntries) return [];
    if (!query) return effectiveFileSystemEntries.slice(0, 50);
    const lowerQuery = query.toLowerCase();
    return effectiveFileSystemEntries
      .filter((entry) => entry.name.toLowerCase().includes(lowerQuery))
      .slice(0, 50);
  };

  const filterCommandSuggestions = (query: string): Command[] => {
    if (!effectiveCommands) return [];
    if (!query) return effectiveCommands.slice(0, 50);
    const lowerQuery = query.toLowerCase();
    return effectiveCommands
      .filter((command) => command.name.toLowerCase().includes(lowerQuery))
      .slice(0, 50);
  };

  const resetAutocomplete = () => {
    setAutocomplete({
      isActive: false,
      triggerIndex: -1,
      query: '',
      suggestions: [],
      focusedIndex: -1,
      type: 'file',
    });
  };

  const handleAutocompleteSelection = (selection: string) => {
    if (!textareaRef.current) return;
    const cursorPos = textareaRef.current.selectionStart;

    if (autocomplete.type === 'emoji') {
      // The emoji replaces the whole `:query`; the trailing space ends the
      // word so the next keystroke starts fresh.
      setValue(value.substring(0, autocomplete.triggerIndex) + selection + ' ' + value.substring(cursorPos));
      resetAutocomplete();
      placeCaret(autocomplete.triggerIndex + selection.length + 1);
    } else if (autocomplete.type === 'command') {
      const newText =
        value.substring(0, autocomplete.triggerIndex) +
        selection +
        ' ' +
        value.substring(cursorPos);
      setValue(newText);
      resetAutocomplete();
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = autocomplete.triggerIndex + selection.length + 1;
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
          textareaRef.current.focus();
          adjustTextareaHeight();
        }
      }, 0);
    } else {
      const newText =
        value.substring(0, autocomplete.triggerIndex + 1) +
        selection +
        ' ' +
        value.substring(cursorPos);
      setValue(newText);
      resetAutocomplete();
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = autocomplete.triggerIndex + 1 + selection.length + 1;
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
          textareaRef.current.focus();
          adjustTextareaHeight();
        }
      }, 0);
    }
  };

  // ── Text input ──

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    adjustTextareaHeight();

    const cursorPos = e.target.selectionStart;

    const completed = completedEmoji(newValue, cursorPos);
    if (completed) {
      setValue(newValue.substring(0, completed.start) + completed.emoji + newValue.substring(cursorPos));
      resetAutocomplete();
      placeCaret(completed.start + completed.emoji.length);
      return;
    }

    const emojiAutocompleteInfo = detectEmojiAutocomplete(newValue, cursorPos);
    if (emojiAutocompleteInfo) {
      const suggestions = searchEmoji!(emojiAutocompleteInfo.query);
      // No matches: stay closed so Enter still sends.
      if (suggestions.length > 0) {
        setAutocomplete((prev) => ({
          isActive: true,
          triggerIndex: emojiAutocompleteInfo.triggerIndex,
          query: emojiAutocompleteInfo.query,
          suggestions,
          type: 'emoji',
          // A new query means a new list; start the highlight at the top.
          focusedIndex: prev.type === 'emoji' && prev.isActive && prev.query === emojiAutocompleteInfo.query
            ? prev.focusedIndex
            : 0,
        }));
        return;
      }
    }

    const commandAutocompleteInfo = detectSlashCommandAutocomplete(newValue, cursorPos);
    if (commandAutocompleteInfo && onFetchCommands) {
      if (effectiveCommands.length === 0) void fetchCommands();
      const suggestions = filterCommandSuggestions(commandAutocompleteInfo.query);
      setAutocomplete((prev) => ({
        isActive: true,
        triggerIndex: commandAutocompleteInfo.triggerIndex,
        query: commandAutocompleteInfo.query,
        suggestions,
        type: commandAutocompleteInfo.type,
        focusedIndex:
          prev.focusedIndex >= 0 && prev.focusedIndex < suggestions.length
            ? prev.focusedIndex
            : -1,
      }));
      return;
    }

    if (enableFileAutocomplete) {
      const fileAutocompleteInfo = detectAutocomplete(newValue, cursorPos);
      if (fileAutocompleteInfo) {
        if (effectiveFileSystemEntries.length === 0) void fetchFileSystemEntries();
        const suggestions = filterSuggestions(fileAutocompleteInfo.query);
        setAutocomplete((prev) => ({
          isActive: true,
          triggerIndex: fileAutocompleteInfo.triggerIndex,
          query: fileAutocompleteInfo.query,
          suggestions,
          type: fileAutocompleteInfo.type,
          focusedIndex:
            prev.focusedIndex >= 0 && prev.focusedIndex < suggestions.length
              ? prev.focusedIndex
              : -1,
        }));
        return;
      }
    }

    resetAutocomplete();
  };

  // ── Submit ──

  const handleSubmit = () => {
    const currentValue = textareaRef.current?.value ?? value;
    const trimmedValue = currentValue.trim();
    if (!trimmedValue && !hasAttachments && !allowEmptySubmit) return;
    if (isProcessingAttachments) return;

    const attachmentBlocks = hasAttachments ? getContentBlocks() : undefined;

    // Save draft backup before clearing
    const backupKey = `${draftStorageKey}-backup`;
    try {
      localStorage.setItem(backupKey, currentValue);
    } catch {
      /* quota exceeded */
    }

    void onSubmit(trimmedValue, {
      workingDirectory: workingDirectory || undefined,
      attachments: attachmentBlocks,
      ...(isModelSelectorEnabled ? { model: selectedModel ?? undefined } : {}),
      ...(effortProvided ? { effort: selectedEffort ?? undefined } : {}),
    });

    setValue('');
    storage.set(draftStorageKey, '');
    clearAttachments();
    resetAutocomplete();
  };

  // ── Keyboard ──

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (autocomplete.isActive) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (autocomplete.suggestions.length > 0) {
            setAutocomplete((prev) => ({
              ...prev,
              focusedIndex:
                prev.focusedIndex < 0 ? 0 : (prev.focusedIndex + 1) % prev.suggestions.length,
            }));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (autocomplete.suggestions.length > 0) {
            setAutocomplete((prev) => ({
              ...prev,
              focusedIndex:
                prev.focusedIndex < 0
                  ? prev.suggestions.length - 1
                  : prev.focusedIndex === 0
                    ? prev.suggestions.length - 1
                    : prev.focusedIndex - 1,
            }));
          }
          break;
        case 'Enter':
        case 'Tab':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            if (autocomplete.suggestions.length > 0) {
              const targetIndex =
                autocomplete.focusedIndex >= 0 ? autocomplete.focusedIndex : 0;
              const suggestion = autocomplete.suggestions[targetIndex];
              const suggestionName =
                autocomplete.type === 'emoji'
                  ? (suggestion as EmojiSuggestion).emoji
                  : autocomplete.type === 'command'
                    ? (suggestion as Command).name
                    : (suggestion as FileSystemEntry).name;
              handleAutocompleteSelection(suggestionName);
            }
          }
          break;
        case ' ':
          resetAutocomplete();
          break;
        case 'Escape':
          e.preventDefault();
          resetAutocomplete();
          setTimeout(() => textareaRef.current?.focus(), 0);
          break;
      }
    } else if (e.key === 'Enter') {
      if (e.shiftKey) return; // Allow newline
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'c' && e.ctrlKey && (isSessionActive || isSessionConnected)) {
      e.preventDefault();
      void onInterrupt?.();
    }
  };

  // ── Textarea auto-resize ──

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    }
  };

  useEffect(() => adjustTextareaHeight(), [value]);
  useEffect(() => {
    const handleResize = () => adjustTextareaHeight();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ── File attachment handlers ──

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!enableAttachments) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!enableAttachments) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!enableAttachments) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!enableAttachments) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) addFiles(files);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  };

  // ── Status ──
  // One short neutral label. Transitional states (starting / stopping /
  // compacting) get a spinner because they are the only ones the person is
  // waiting out; steady states are the word alone.

  const statusLabel = isInitializing
    ? 'Starting'
    : isStopRequested
      ? 'Stopping'
      : isCompacting
        ? 'Compacting context'
        : isSessionActive
          ? 'Working'
          : hasBackgroundTasks && isSessionConnected
            ? backgroundTaskLabel
            : isSessionConnected
              ? 'Ready'
              : 'Idle';

  const isStatusSpinning = isInitializing || isStopRequested || isCompacting;

  const sendDisabled =
    (!value.trim() && !hasAttachments && !allowEmptySubmit) ||
    disabled ||
    isProcessingAttachments;

  // Foot-row controls share one shape: a 30px circle, quiet until hovered.
  const footButton =
    'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full transition-colors duration-100';
  const footBadge =
    'flex h-7 items-center rounded-md px-2 text-xs text-composer-text-secondary transition-colors whitespace-nowrap';

  // ── Render ──

  return (
    <TooltipProvider>
      <div ref={composerRef} className={cn('w-full relative', props.className)}>
        {/* Hidden file input */}
        {enableAttachments && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILE_TYPES}
            className="hidden"
            onChange={handleFileInputChange}
          />
        )}

        {/* Main container: text above, controls below, one flat surface that
            steps up a shade while focused. */}
        <div
          data-composer-status={
            isInitializing ? 'starting'
            : isStopRequested ? 'stopping'
            : isCompacting ? 'compacting'
            : isSessionActive ? 'active'
            : isSessionConnected ? 'ready'
            : 'off'
          }
          className="relative rounded-[10px] bg-composer-surface transition-colors duration-200 focus-within:bg-composer-surface-elevated"
        >
          {/* Input area with drag-drop */}
          <div
            className={cn(
              'flex flex-col w-full cursor-text relative rounded-[10px]',
              isDragOver && 'ring-1 ring-composer-active/60 ring-inset',
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 flex items-center justify-center rounded-[10px] bg-composer-surface-elevated/90 z-10 pointer-events-none">
                <div className="flex items-center gap-2 text-sm text-composer-text">
                  <Paperclip size={16} />
                  <span>Drop files to attach</span>
                </div>
              </div>
            )}

            {/* Attachment preview strip */}
            {hasAttachments && (
              <div className="flex gap-1.5 px-3 pt-3 w-full overflow-x-auto">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="relative group flex-shrink-0 flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-composer-surface-elevated"
                  >
                    {att.type === 'image' ? (
                      <Image size={14} className="text-composer-text-secondary" />
                    ) : (
                      <FileText size={14} className="text-composer-text-secondary" />
                    )}
                    <span className="text-xs text-composer-text max-w-[140px] truncate">
                      {att.name}
                    </span>
                    {att.status === 'processing' && (
                      <Loader2 size={12} className="animate-spin text-composer-text-secondary" />
                    )}
                    {att.status === 'error' && (
                      <span className="text-composer-danger text-xs">!</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      aria-label={`Remove ${att.name}`}
                      className={cn(
                        TOUCH_TARGET_32,
                        'ml-0.5 p-0.5 rounded-sm text-composer-text-faint hover:text-composer-text transition-colors',
                      )}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {attachmentError && (
                  <span className="text-xs text-composer-danger self-center">
                    {attachmentError}
                  </span>
                )}
              </div>
            )}

            <textarea
              ref={textareaRef}
              data-testid="composer-input"
              className="w-full border-none bg-transparent text-composer-text text-sm leading-relaxed resize-none outline-none overflow-y-auto min-h-[40px] px-3.5 pt-3 pb-1 placeholder:text-composer-text-faint"
              style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              placeholder={placeholder}
              value={value}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              disabled={disabled}
            />

            {/* Foot: attach + state on the left, model / context / send on the right */}
            <div
              data-testid="composer-status-bar"
              className="flex items-center justify-between gap-1 px-1.5 pb-1.5 pt-0.5 min-h-[36px]"
            >
              {/* On a phone the foot is narrower than its contents. The status and
                  the send/stop buttons never give up space; the model label
                  truncates first, then the badges between them scroll sideways. */}
              <div className="flex items-center gap-1 shrink-0">
                {enableAttachments && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled}
                    aria-label="Add attachment"
                    className={cn(
                      TOUCH_TARGET_44,
                      footButton,
                      'text-composer-text-faint hover:text-composer-text hover:bg-composer-surface-elevated disabled:opacity-45 disabled:cursor-not-allowed',
                    )}
                  >
                    <Plus size={16} />
                  </button>
                )}
                {renderLeadingActions?.()}

                {showStatusBar && (
                  <div className="flex items-center gap-2 pl-1.5">
                    {isStatusSpinning && (
                      <Loader2 size={12} className="shrink-0 animate-spin text-composer-caution" />
                    )}
                    <span className="text-xs text-composer-text-secondary whitespace-nowrap">{statusLabel}</span>
                    {isSessionActive && hasSessionStartTime && (
                      <span className="hidden sm:inline text-xs tabular-nums text-composer-text-faint">{elapsedTime}</span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1 min-w-0 shrink">
                {showStatusBar && (
                  // py-2/-my-2 keeps the badges' 44px tap areas inside the scroll clip.
                  <div
                    ref={badgesRef}
                    onScroll={(e) => measureBadges(e.currentTarget)}
                    data-testid="composer-status-badges"
                    className={cn(
                      'flex items-center gap-1 min-w-0 overflow-x-auto py-2 -my-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                      badgesClipped && '[mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]',
                    )}
                  >
                    {isModelSelectorEnabled ? (
                      <div className="relative flex min-w-[72px] shrink" ref={modelMenuRef} data-testid="model-selector">
                        <button
                          ref={modelTriggerRef}
                          type="button"
                          onClick={() => (isModelMenuOpen ? closeModelMenu(false) : setIsModelMenuOpen(true))}
                          className={cn(
                            'composer-model-badge',
                            footBadge,
                            'min-w-0 gap-1 cursor-pointer hover:bg-composer-surface-elevated hover:text-composer-text',
                            sessionModelFallback && 'text-amber-400',
                            isModelMenuOpen && 'bg-composer-surface-elevated text-composer-text',
                          )}
                          data-testid="session-model"
                          aria-haspopup="menu"
                          aria-expanded={isModelMenuOpen}
                          title={sessionModelFallback && sessionModel ? `Select model. Serving model differs from the session's configured model (${sessionModel})` : 'Select model'}
                        >
                          <span
                            className="truncate"
                            data-model={selectedModel ?? undefined}
                            data-effort={selectedEffort ?? undefined}
                          >
                            {effectiveModel?.label ?? (sessionModel ? formatModelName(sessionModel) : 'Model')}
                            {badgeEffortLabel && <span> · {badgeEffortLabel}</span>}
                          </span>
                          <ChevronDown
                            size={12}
                            className={cn('shrink-0 transition-transform', isModelMenuOpen && 'rotate-180')}
                          />
                        </button>
                      </div>
                    ) : sessionModel ? (
                      <div
                        className={cn(footBadge, 'min-w-[72px] shrink', sessionModelFallback && 'text-amber-400')}
                        data-testid="session-model"
                        title={sessionModelFallback ? `Serving model differs from the session's configured model (${sessionModel})` : sessionModel}
                      >
                        <span className="truncate" data-model={sessionModel}>{formatModelName(sessionModel)}</span>
                      </div>
                    ) : null}
                    {/* Host-app status content, adjacent to the model badge. */}
                    {renderStatusExtra?.()}
                    {sessionUsage && (() => {
                      const tokens = sessionUsage.contextTokens ?? (sessionUsage.inputTokens + sessionUsage.cacheCreationInputTokens + sessionUsage.cacheReadInputTokens);
                      const tokenColor = tokens >= 500_000 ? 'text-composer-danger' : tokens >= 200_000 ? 'text-amber-400' : undefined;
                      return (
                        <div className={cn(footBadge, 'shrink-0', tokenColor)} data-testid="token-usage">
                          <span data-tokens={tokens}>{formatTokenCount(tokens)}<span className="hidden sm:inline"> tokens</span></span>
                        </div>
                      );
                    })()}
                    {queuedMessages.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setQueueDialogOpen(true)}
                            className={cn(footBadge, 'shrink-0 cursor-pointer text-composer-caution hover:bg-composer-surface-elevated')}
                          >
                            Queued {queuedMessages.length}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>Per-session message queue. These auto-send in order when the current run finishes.</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}

                {/* Menu toggle */}
                {!isSessionActive && !isSessionConnected && showMenu && (
                  <button
                    key="menu"
                    type="button"
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
                    title="Menu"
                    className={cn(
                      TOUCH_TARGET_44,
                      footButton,
                      'cursor-pointer',
                      isMenuOpen
                        ? 'bg-composer-surface-elevated text-composer-text'
                        : 'text-composer-text-faint hover:text-composer-text hover:bg-composer-surface-elevated',
                    )}
                  >
                    <ChevronUp size={16} />
                  </button>
                )}
                {renderActionsExtra?.()}
                {/* Send button — takes the accent only once there is something to send */}
                <button
                  key="send"
                  type="button"
                  data-testid="send-button"
                  // Emptiness belongs on the native attribute, not just
                  // aria-disabled: hosts style the idle state off :disabled,
                  // and an aria-only button stays focusable and clickable.
                  disabled={sendDisabled}
                  aria-disabled={sendDisabled}
                  onClick={handleSubmit}
                  aria-label="Send message"
                  className={cn(
                    TOUCH_TARGET_44,
                    footButton,
                    sendDisabled
                      ? 'text-composer-text-faint cursor-not-allowed'
                      : 'text-composer-active hover:bg-composer-active/15 cursor-pointer',
                  )}
                >
                  <Send size={16} />
                </button>
                {/* Stop button */}
                {(isSessionActive || isStopRequested) && (
                  <button
                    key="stop"
                    type="button"
                    className={cn(
                      TOUCH_TARGET_44,
                      footButton,
                      isStopRequested
                        ? 'text-composer-caution cursor-default'
                        : 'text-composer-text hover:bg-composer-danger/15 hover:text-composer-danger cursor-pointer',
                    )}
                    onClick={() => onStop?.()}
                    data-testid="stop-button"
                    aria-label={isStopRequested ? 'Stop requested' : 'Stop session'}
                  >
                    {isStopRequested ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Square size={12} fill="currentColor" />
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Queue dialog */}
            <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle className="text-sm font-medium text-composer-text">
                    Queued messages ({queuedMessages.length})
                  </DialogTitle>
                  <DialogDescription className="text-xs text-composer-text-secondary">
                    Per-session queue. These auto-send in order when the current run finishes.
                  </DialogDescription>
                </DialogHeader>

                <div className="max-h-[55vh] overflow-y-auto space-y-2 pr-1">
                  {queuedMessages.map((queuedMessage) => (
                    <div
                      key={queuedMessage.id}
                      className="rounded-md px-3 py-2 bg-composer-surface"
                    >
                      <p className="text-sm text-composer-text whitespace-pre-wrap break-words">
                        {queuedMessage.content}
                      </p>
                      <p className="text-xs text-composer-text-faint mt-1">
                        {queuedMessage.status === 'dispatching'
                          ? 'sending...'
                          : `queued ${new Date(queuedMessage.timestamp).toLocaleTimeString()}`}
                      </p>
                    </div>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Model selector menu — rendered at the root wrapper so it escapes the
            main card's `overflow-hidden` clipping, mirroring the autocomplete
            dropdown's escape pattern. Anchors to the trigger position (top-right). */}
        {isModelSelectorEnabled && isModelMenuOpen && (() => {
          // Semantic class hooks for product skinning (the toolkit's established
          // inversion pattern — consumers restyle these via CSS, not by forking):
          //   composer-model-menu              — the popover panel
          //   composer-model-menu-section      — a section header ("Model"/"Reasoning")
          //   composer-model-menu-item         — a selectable row
          //   composer-model-menu-item-label   — the row's primary label
          //   composer-model-menu-item-description — the row's secondary description
          //   composer-model-badge             — the interactive trigger badge (above)
          const renderRow = (
            row: { id: string; label: string; description?: string; isDefault?: boolean },
            kind: 'model' | 'effort',
            flatIndex: number,
            isChecked: boolean,
          ) => (
            <button
              key={row.id}
              type="button"
              role="menuitemradio"
              aria-checked={isChecked}
              data-menu-option
              tabIndex={flatIndex === modelMenuFocusIndex ? 0 : -1}
              onClick={() => activateMenuRow({ kind, id: row.id, isDefault: row.isDefault })}
              className={cn(
                'composer-model-menu-item flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer outline-none',
                'hover:bg-composer-surface-elevated focus:bg-composer-surface-elevated focus-visible:bg-composer-surface-elevated',
              )}
              data-testid={`${kind}-option-${row.id}`}
            >
              <span className="mt-0.5 w-3.5 shrink-0">
                {isChecked && <Check size={14} className="text-composer-text" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn('composer-model-menu-item-label text-sm truncate', isChecked ? 'text-composer-text' : 'text-composer-text-secondary')}>
                    {row.label}
                  </span>
                  {row.isDefault && (
                    <span className="text-[11px] text-composer-text-faint whitespace-nowrap">
                      default
                    </span>
                  )}
                </span>
                {row.description && (
                  <span className="composer-model-menu-item-description block text-xs leading-snug text-composer-text-faint mt-0.5">
                    {row.description}
                  </span>
                )}
              </span>
            </button>
          );

          const sectionHeader = (label: string) => (
            <div className="composer-model-menu-section px-2 pt-2 pb-1 text-xs font-medium text-composer-text-faint">
              {label}
            </div>
          );

          return (
            <div
              ref={modelMenuListRef}
              role="menu"
              data-testid="model-menu"
              onKeyDown={handleModelMenuKeyDown}
              className="composer-model-menu absolute right-0 bottom-full z-50 mb-2 min-w-[200px] max-w-[min(300px,calc(100vw-2rem))] rounded-[10px] border border-composer-border bg-composer-surface p-1"
            >
              {isEffortSelectorEnabled && sectionHeader('Model')}
              {availableModels.map((model, i) =>
                renderRow(model, 'model', i, model.id === (effectiveModel?.id ?? null)),
              )}
              {isEffortSelectorEnabled && (
                <>
                  {sectionHeader('Reasoning')}
                  {availableEfforts.map((eff, i) =>
                    renderRow(
                      eff,
                      'effort',
                      availableModels.length + i,
                      eff.id === (effectiveEffort?.id ?? null),
                    ),
                  )}
                </>
              )}
            </div>
          );
        })()}

        {/* Menu slot */}
        {showMenu && isMenuOpen && props.renderMenu?.({ onClose: () => setIsMenuOpen(false) })}

        {/* Autocomplete dropdown */}
        {(enableFileAutocomplete || onFetchCommands || searchEmoji) && (
          <AutocompleteDropdown
            suggestions={autocomplete.suggestions}
            onSelect={handleAutocompleteSelection}
            onClose={resetAutocomplete}
            isOpen={autocomplete.isActive && autocomplete.suggestions.length > 0}
            focusedIndex={autocomplete.focusedIndex}
            type={autocomplete.type}
            onFocusReturn={() => textareaRef.current?.focus()}
          />
        )}
      </div>
    </TooltipProvider>
  );
});
