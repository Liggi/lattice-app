/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
/**
 * ActionQueueDialog - Unified action queue combining user notes + AI recommendations.
 *
 * A first-class feature accessible from the header. Users can add their own
 * notes, and AI-generated recommendations from session reviews
 * auto-populate as a separate section. Everything launches together in one session.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ListTodo, X, Plus, Check, Trash2, AlertCircle, Loader2, Play,
  Zap, Bot, Wrench, Code, Pencil, ShieldOff, ExternalLink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import type { DevNote, StoredRecommendation } from '../../types';
import { readQueueSessionDraft } from '../ConversationHeader/queue-session';
import {
  persistLastLaunchPermissionMode,
  resolveInitialLaunchPermissionMode,
} from '../../utils/session-launch-permissions';

// Re-export the component under the old name for backwards compat
export { ActionQueueDialog as DevNotesDialog };

import type { Provider } from '@/types/unified-messages';

export type { Provider };
export type PermissionMode = 'bypassPermissions';

/** First section of a friction/action/rationale packed string. */
function farFriction(packed: string): string {
  const parts = packed.includes('\n---\n') ? packed.split('\n---\n') : packed.split(' --- ');
  return parts[0]?.trim() || '';
}

export interface ActionQueueDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunchSession?: (
    notes: DevNote[],
    recommendations: StoredRecommendation[],
    provider?: Provider,
    permissionMode?: PermissionMode
  ) => Promise<{ sessionId: string } | null | void> | { sessionId: string } | null | void;
  defaultProvider?: Provider;
  defaultPermissionMode?: string;
  initialProvider?: Provider;
  initialPermissionMode?: string;
}

const targetConfig: Record<string, { icon: React.ElementType; text: string; bg: string }> = {
  codebase: { icon: Wrench, text: 'text-fg-3', bg: 'bg-surface-2' },
  project_instructions: { icon: Code, text: 'text-fg-3', bg: 'bg-surface-2' },
  global_instructions: { icon: Zap, text: 'text-fg-3', bg: 'bg-surface-2' },
};

function getTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
}

function sortNotesByCreatedAt(notes: DevNote[]): DevNote[] {
  return [...notes].sort((a, b) => (
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ));
}

export function ActionQueueDialog({
  isOpen,
  onClose,
  onLaunchSession,
  defaultProvider = 'claude',
  defaultPermissionMode,
  initialProvider,
  initialPermissionMode,
}: ActionQueueDialogProps): JSX.Element | null {
  const navigate = useNavigate();
  const [notes, setNotes] = useState<DevNote[]>([]);
  const [recommendations, setRecommendations] = useState<StoredRecommendation[]>([]);
  // Persist draft note to localStorage so it survives dialog close, errors, or page refresh
  const [newNoteContent, setNewNoteContentRaw] = useState(() => {
    try { return localStorage.getItem('lattice-dev-note-draft') || ''; } catch { return ''; }
  });
  const setNewNoteContent = (v: string) => {
    setNewNoteContentRaw(v);
    try { if (v) localStorage.setItem('lattice-dev-note-draft', v); else localStorage.removeItem('lattice-dev-note-draft'); } catch { /* quota */ }
  };
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLaunchingSession, setIsLaunchingSession] = useState(false);
  const [launchedSessionId, setLaunchedSessionId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider>(initialProvider || defaultProvider);
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionMode>(() => (
    resolveInitialLaunchPermissionMode({
      explicit: initialPermissionMode,
      fallback: defaultPermissionMode,
      provider: initialProvider || defaultProvider,
    })
  ));
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLaunchPrompt, setLastLaunchPrompt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const orderedNotes = sortNotesByCreatedAt(notes);

  const totalCount = notes.length + recommendations.length;

  // Group recommendations by project for display
  const recsByProject = useMemo(() => {
    const groups = new Map<string, StoredRecommendation[]>();
    for (const rec of recommendations) {
      const key = rec.sourceProject || 'General';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(rec);
    }
    return [...groups.entries()];
  }, [recommendations]);

  // Fetch notes and recommendations when dialog opens
  useEffect(() => {
    if (isOpen) {
      setIsLaunchingSession(false);
      setLaunchedSessionId(null);
      setEditingNoteId(null);
      setEditingNoteContent('');
      if (initialProvider) {
        setSelectedProvider(initialProvider);
      }
      if (initialPermissionMode) {
        setSelectedPermissionMode(resolveInitialLaunchPermissionMode({
          explicit: initialPermissionMode,
          fallback: defaultPermissionMode,
          provider: initialProvider || defaultProvider,
        }));
      }
      setLastLaunchPrompt(readQueueSessionDraft()?.prompt || null);
      void fetchAll();
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, initialProvider, initialPermissionMode, defaultPermissionMode, defaultProvider]);

  useEffect(() => {
    if (selectedPermissionMode !== 'bypassPermissions') {
      setSelectedPermissionMode('bypassPermissions');
      persistLastLaunchPermissionMode('bypassPermissions');
    }
  }, [selectedPermissionMode]);

  const handleCopyLastPrompt = useCallback(async () => {
    const prompt = lastLaunchPrompt || readQueueSessionDraft()?.prompt;
    if (!prompt) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
        return;
      }
    } catch {
      // Fall back below.
    }

    const textArea = document.createElement('textarea');
    textArea.value = prompt;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }, [lastLaunchPrompt]);

  const fetchAll = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [notesRes, recsRes] = await Promise.all([
        api.getDevNotes(),
        api.getPendingRecommendations(),
      ]);
      setNotes(sortNotesByCreatedAt(notesRes.notes));
      setRecommendations(recsRes.recommendations as StoredRecommendation[]);
    } catch (err) {
      setError('Failed to load queue');
      console.error('Failed to fetch action queue:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = useCallback(async () => {
    if (!newNoteContent.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await api.createDevNote({
        content: newNoteContent.trim(),
      });
      setNewNoteContent('');
      await fetchAll();
    } catch (err) {
      setError('Failed to create note');
      console.error('Failed to create dev note:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [newNoteContent, isSubmitting]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  // Note actions
  const handleMarkNoteDone = async (id: string) => {
    try {
      await api.updateDevNoteStatus(id, 'done');
      if (editingNoteId === id) {
        setEditingNoteId(null);
        setEditingNoteContent('');
      }
      setNotes(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to mark note as done:', err);
    }
  };

  const handleDeleteNote = async (id: string) => {
    try {
      await api.deleteDevNote(id);
      if (editingNoteId === id) {
        setEditingNoteId(null);
        setEditingNoteContent('');
      }
      setNotes(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  const handleStartEditingNote = useCallback((note: DevNote) => {
    setEditingNoteId(note.id);
    setEditingNoteContent(note.content);
  }, []);

  const handleCancelEditingNote = useCallback(() => {
    setEditingNoteId(null);
    setEditingNoteContent('');
  }, []);

  const handleSaveEditingNote = useCallback(async () => {
    if (!editingNoteId || isSavingNote) return;

    const trimmedContent = editingNoteContent.trim();
    if (!trimmedContent) {
      setError('Note content cannot be empty');
      return;
    }

    setIsSavingNote(true);
    setError(null);
    try {
      await api.updateDevNote(editingNoteId, {
        content: trimmedContent,
      });

      setNotes(prev => prev.map(note => (
        note.id === editingNoteId
          ? { ...note, content: trimmedContent }
          : note
      )));
      handleCancelEditingNote();
    } catch (err) {
      setError('Failed to update note');
      console.error('Failed to update dev note:', err);
    } finally {
      setIsSavingNote(false);
    }
  }, [editingNoteId, editingNoteContent, isSavingNote, handleCancelEditingNote]);

  // Recommendation actions
  const handleCompleteRec = async (id: string) => {
    try {
      await api.completeRecommendation(id);
      setRecommendations(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      console.error('Failed to complete recommendation:', err);
    }
  };

  const handleDismissRec = async (id: string) => {
    try {
      await api.dismissRecommendation(id);
      setRecommendations(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      console.error('Failed to dismiss recommendation:', err);
    }
  };

  const handleLaunchSession = useCallback(async () => {
    if (launchedSessionId) {
      onClose();
      void navigate(`/c/${launchedSessionId}`);
      return;
    }
    if (totalCount === 0 || !onLaunchSession || isLaunchingSession) return;

    setIsLaunchingSession(true);
    setError(null);
    try {
      const result = await onLaunchSession(notes, recommendations, selectedProvider, selectedPermissionMode);
      if (result?.sessionId) {
        setLaunchedSessionId(result.sessionId);
      } else {
        setError('Session started but no session ID was returned');
      }
    } catch (err) {
      setError('Failed to start session');
      setLastLaunchPrompt(readQueueSessionDraft()?.prompt || null);
      console.error('Failed to launch queue session:', err);
    } finally {
      setIsLaunchingSession(false);
    }
  }, [launchedSessionId, totalCount, onLaunchSession, isLaunchingSession, notes, recommendations, onClose, navigate, selectedProvider, selectedPermissionMode]);

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setSelectedPermissionMode(mode);
    persistLastLaunchPermissionMode(mode);
  }, []);

  const permissionModes = [
    {
      mode: 'bypassPermissions' as const,
      label: 'Trust',
      icon: ShieldOff,
      activeClasses: 'bg-[rgb(var(--color-amber-rgb)/0.1)] text-amber-400 border border-transparent',
      description: 'Skip all permission prompts. Runs freely with no restrictions.',
    },
  ];

  const renderNotes = () => {
    if (orderedNotes.length === 0) return null;
    return (
      <div className="mb-1">
        <div className="flex items-center gap-2 px-3 py-1">
          <ListTodo size={10} className="text-fg-3" />
          <span className="text-xs font-medium text-fg-2">
            Notes
          </span>
        </div>
        <div className="space-y-0.5">
          {orderedNotes.map(note => (
            <div key={note.id} className="group px-3 py-1.5 hover:bg-surface-2 transition-colors">
              {editingNoteId === note.id ? (
                <div className="space-y-2">
                  <input
                    value={editingNoteContent}
                    onChange={(e) => setEditingNoteContent(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm bg-bg border border-line-2 rounded-md text-fg focus:outline-none focus:border-accent"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleSaveEditingNote();
                      }
                    }}
                  />

                  <div className="flex items-center justify-end gap-1">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => void handleSaveEditingNote()}
                        disabled={isSavingNote || !editingNoteContent.trim()}
                        className="p-1 text-fg-3 hover:text-emerald-400 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Save note"
                      >
                        {isSavingNote ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      </button>
                      <button
                        onClick={handleCancelEditingNote}
                        disabled={isSavingNote}
                        className="p-1 text-fg-3 hover:text-rose-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Cancel edit"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <p className="flex-1 min-w-0 text-sm text-fg leading-snug break-words">{note.content}</p>
                  <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
                    <span className="hidden sm:inline text-xs text-fg-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      {getTimeAgo(note.createdAt)}
                    </span>
                    <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleStartEditingNote(note)}
                        className="p-1 text-fg-3 hover:text-fg cursor-pointer"
                        title="Edit note"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => void handleMarkNoteDone(note.id)}
                        className="p-1 text-fg-3 hover:text-emerald-400 cursor-pointer"
                        title="Mark done"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        onClick={() => void handleDeleteNote(note.id)}
                        className="p-1 text-fg-3 hover:text-rose-300 cursor-pointer"
                        title="Delete note"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <div className="h-0.5" />
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 10vh)',
        paddingRight: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
      }}
    >
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close queue dialog"
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-md mx-4 bg-surface border border-line rounded-lg overflow-hidden max-h-[80vh] flex flex-col">
        {/* Header with count badges */}
        <div className="relative border-b border-line">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <ListTodo size={14} className="text-fg-3" />
                <span className="text-sm font-medium text-fg">
                  Action queue
                </span>
              </div>
              {totalCount > 0 && (
                <div className="flex items-center gap-1">
                  {recommendations.length > 0 && (
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center text-xs tabular-nums bg-surface-2 text-fg-2 border border-line rounded-sm">
                      {recommendations.length}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1 text-fg-3 hover:text-fg transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
          <p className="px-4 pb-2 text-xs leading-relaxed text-fg-3">
            Backlog for future sessions. Items stay here until you start a dedicated session. This is separate from the per-session message queue in the composer.
          </p>
        </div>

        {/* Input */}
        <div className="relative px-4 py-3 border-b border-line">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={newNoteContent}
              onChange={(e) => setNewNoteContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a note..."
              className="flex-1 px-3 py-1.5 bg-bg border border-line-2 rounded-md text-sm text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent"
            />
            <button
              onClick={() => void handleSubmit()}
              disabled={!newNoteContent.trim() || isSubmitting}
              className="px-2.5 py-1.5 rounded-md text-accent hover:bg-accent-soft transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="relative flex-1 overflow-y-auto p-2 min-h-[150px] max-h-96 flex flex-col">
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-fg-3" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-rose-300">
              <div className="flex items-center justify-center gap-2">
                <AlertCircle size={16} />
                <span className="text-sm">{error}</span>
              </div>
              {lastLaunchPrompt && (
                <button
                  onClick={() => void handleCopyLastPrompt()}
                  className="ui-action-btn ui-action-btn--rose px-2 py-1 text-xs cursor-pointer"
                >
                  Copy last prompt
                </button>
              )}
            </div>
          ) : totalCount === 0 ? (
            <div className="flex flex-1 min-h-[220px] flex-col items-center justify-center py-8 text-center text-fg-3">
              <ListTodo size={24} className="mb-2 opacity-50" />
              <span className="text-sm">Action queue empty</span>
              <span className="text-xs mt-1">Add a note above, or review a session to generate recommendations</span>
            </div>
          ) : (
            <>
              {renderNotes()}

              {/* AI Recommendations section — grouped by project */}
              {recommendations.length > 0 && (
                <>
                  {/* Divider (only if there are also notes) */}
                  {notes.length > 0 && (
                    <div className="flex items-center gap-2 px-3 py-2 mt-2">
                      <div className="flex-1 border-t border-line" />
                      <span className="text-xs text-fg-3">AI</span>
                      <div className="flex-1 border-t border-line" />
                    </div>
                  )}

                  <div className="mb-1">
                    <div className="flex items-center gap-2 px-3 py-1">
                      <Bot size={10} className="text-fg-3" />
                      <span className="text-xs font-medium text-fg-2">
                        Recommendations
                      </span>
                      <span className="text-xs text-fg-3 tabular-nums">({recommendations.length})</span>
                    </div>
                    {recsByProject.map(([project, recs]) => (
                      <div key={project} className="mb-2">
                        {/* Project group header */}
                        <div className="flex items-center gap-2 px-3 py-1.5">
                          <span className="text-xs font-medium text-fg-2">
                            {project}
                          </span>
                          <span className="text-xs text-fg-3 tabular-nums">
                            {recs.length}
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {recs.map(rec => {
                            const target = targetConfig[rec.target] || targetConfig.codebase;
                            const TargetIcon = target.icon;
                            const frictionOneLiner = rec.friction
                              ? (() => {
                                const firstSection = farFriction(rec.friction);
                                // Truncate to first sentence or 140 chars
                                const firstSentence = firstSection.match(/^[^.!?]+[.!?]/)?.[0] || firstSection;
                                return firstSentence.length > 140
                                  ? firstSentence.slice(0, 140) + '...'
                                  : firstSentence;
                              })()
                              : '';
                            return (
                              <div
                                key={rec.id}
                                className="group px-3 py-2 hover:bg-surface-2 transition-colors"
                              >
                                {/* Title row */}
                                <div className="flex items-start gap-2">
                                  <div className={`p-1 rounded-sm ${target.bg} flex-shrink-0 mt-0.5`}>
                                    <TargetIcon size={10} className={target.text} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm text-fg leading-snug">{rec.action}</p>
                                  </div>
                                </div>
                                {/* Friction context — truncated one-liner */}
                                {frictionOneLiner && (
                                  <p className="text-xs text-fg-3 mt-1 pl-7 leading-snug line-clamp-2">
                                    {frictionOneLiner}
                                  </p>
                                )}
                                {/* Meta row: time, session link, actions */}
                                <div className="flex items-center gap-2 mt-1.5 pl-7">
                                  <span className="text-xs text-fg-3">
                                    {getTimeAgo(rec.createdAt)}
                                  </span>
                                  {rec.sessionId && (
                                    <button
                                      onClick={() => { onClose(); void navigate(`/c/${rec.sessionId}`); }}
                                      className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg transition-colors cursor-pointer"
                                      title={rec.sourceMission || 'View source session'}
                                    >
                                      <ExternalLink size={9} />
                                      <span className="truncate max-w-[160px]">
                                        {rec.sourceMission || 'session'}
                                      </span>
                                    </button>
                                  )}
                                  <div className="flex-1" />
                                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                      onClick={() => void handleCompleteRec(rec.id)}
                                      className="p-1 text-fg-3 hover:text-emerald-400 cursor-pointer"
                                      title="Mark complete"
                                    >
                                      <Check size={12} />
                                    </button>
                                    <button
                                      onClick={() => void handleDismissRec(rec.id)}
                                      className="p-1 text-fg-3 hover:text-rose-300 cursor-pointer"
                                      title="Dismiss"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {totalCount > 0 && onLaunchSession && (
          <div className="relative px-4 py-3 border-t border-line space-y-2">
            {!launchedSessionId && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center rounded-md border border-line-2 bg-bg p-0.5">
                  {(['claude', 'codex'] as const).map((provider) => {
                    const isActive = selectedProvider === provider;
                    const Icon = provider === 'claude' ? Bot : Code;
                    return (
                      <button
                        key={provider}
                        onClick={() => setSelectedProvider(provider)}
                        disabled={isLaunchingSession}
                        className={`flex items-center gap-1 px-2 py-1 rounded-sm text-xs font-medium capitalize transition-colors duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                          isActive
                            ? 'bg-surface-2 text-fg border border-transparent'
                            : 'text-fg-3 hover:text-fg border border-transparent'
                        }`}
                      >
                        <Icon size={10} />
                        {provider}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center rounded-md border border-line-2 bg-bg p-0.5">
                  {selectedProvider === 'codex' ? (
                    <div
                      className="flex items-center gap-1 px-2 py-1 rounded-sm border border-transparent bg-[rgb(var(--color-amber-rgb)/0.1)] text-xs font-medium text-amber-400"
                      title="Codex sessions in Lattice always run with no approval prompts and full sandbox access."
                    >
                      <ShieldOff size={10} />
                      Full access
                    </div>
                  ) : permissionModes.map(({ mode, label, icon: Icon, activeClasses, description }) => {
                    const isActive = selectedPermissionMode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => handlePermissionModeChange(mode)}
                        disabled={isLaunchingSession}
                        title={description}
                        className={`flex items-center gap-1 px-2 py-1 rounded-sm text-xs font-medium transition-colors duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                          isActive
                            ? activeClasses
                            : 'text-fg-3 hover:text-fg border border-transparent'
                        }`}
                      >
                        <Icon size={10} />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <button
              onClick={() => void handleLaunchSession()}
              disabled={isLaunchingSession}
              className="ui-action-btn w-full flex items-center justify-center gap-2 py-1.5 text-[13px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLaunchingSession ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Starting session...
                </>
              ) : launchedSessionId ? (
                <>
                  <Play size={12} />
                  Go to session
                </>
              ) : (
                <>
                  <Play size={12} />
                  Start session
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
