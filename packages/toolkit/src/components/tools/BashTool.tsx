import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Terminal, Loader2 } from 'lucide-react';
import { codeToHtml } from 'shiki';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { useToolkitTheme } from '../../context.js';
import { tk, accent } from '../../tokens.js';
import type { BackgroundTaskOutput, BackgroundTaskState } from '../../types.js';
import { formatShellCommand } from '../../utils/format-shell.js';
import { stripRerunFooter } from '../../utils/tool-utils.js';

/** Detect if output is JSON and pretty-print it. Returns [formatted, language]. */
function detectAndFormat(code: string): [string, string] {
  const trimmed = code.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
    try {
      const parsed = JSON.parse(trimmed);
      return [JSON.stringify(parsed, null, 2), 'json'];
    } catch { /* not JSON */ }
  }
  return [code, 'shellscript'];
}

function ShellHighlight({ code, lang }: { code: string; lang?: string }): React.JSX.Element {
  const theme = useToolkitTheme();
  const shikiTheme = theme === 'dark' ? 'github-dark-default' : 'github-light-default';
  const [html, setHtml] = useState<string | null>(null);

  const language = lang || 'shellscript';

  useEffect(() => {
    codeToHtml(code, { lang: language, theme: shikiTheme })
      .then(setHtml).catch(() => setHtml(null));
  }, [code, language, shikiTheme]);

  if (!html) {
    return (
      <pre className={`m-0 font-mono text-[13px] whitespace-pre-wrap break-all leading-relaxed ${tk.text.primary}`}>
        {code}
      </pre>
    );
  }

  return (
    <div
      className="[&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_code]:!bg-transparent"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function PlainOutput({ code }: { code: string }): React.JSX.Element {
  return (
    <pre className={`m-0 font-mono text-[13px] whitespace-pre-wrap break-words leading-relaxed ${tk.text.primary}`}>
      {code}
    </pre>
  );
}

interface BashToolProps {
  input: { command?: string; description?: string; run_in_background?: boolean };
  result: string;
  workingDirectory?: string;
  isPending?: boolean;
  /** Optional: provide a function to fetch background task output. Without this, background output display is disabled. */
  fetchBackgroundOutput?: (path: string) => Promise<BackgroundTaskOutput | null>;
  /** Where a background command stands, from the session's task events. Absent when unknown. */
  backgroundState?: BackgroundTaskState;
}

const BG_OUTPUT_PATTERN = /Output is being written to:\s*(\S+)/;
const POLL_INTERVAL_MS = 2000;
const MAX_DISPLAY_CHARS = 100_000;

export function parseBackgroundOutputPath(result: string): string | null {
  const match = result.match(BG_OUTPUT_PATTERN);
  return match ? match[1] : null;
}

/**
 * Every shell a provider might invoke, with or without an absolute path, and with
 * flags clustered around `c` — Codex wraps each command as `/bin/zsh -lc '…'`,
 * where Claude uses a bare `bash -c '…'`.
 */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)\s+-[a-zA-Z]*c\s+(['"])([\s\S]+)\1$/;

/** Strips the `<shell> -c '…'` wrapper so the card shows the command that was actually run. */
export function unwrapShellCommand(command: string): string {
  const match = command.trim().match(SHELL_WRAPPER);
  if (!match) return command;
  const [, quote, body] = match;
  // POSIX single-quote escaping closes and reopens the quote around each literal quote.
  return quote === "'" ? body.replace(/'\\''/g, "'") : body;
}

export function summarizeCommand(command: string, maxLen: number = 80): string {
  let cmd = unwrapShellCommand(command).trim();
  if (cmd.includes('\n')) {
    const firstLine = cmd.split('\n').find(l => l.trim() && !l.trim().startsWith('#')) || cmd.split('\n')[0];
    cmd = firstLine.trim();
    if (cmd.length <= maxLen) cmd += ' …';
  }
  return cmd.length > maxLen ? cmd.slice(0, maxLen) + '…' : cmd;
}

interface TaskOutputState {
  content: string;
  size: number;
  truncated: boolean;
  fetched: boolean;
}

/**
 * Reads a background command's output file for display. Whether the command
 * is still running comes from the task events, not from here: polling goes on
 * while it runs, and once it has stopped one last read picks up the final output.
 */
function useBackgroundTaskOutput(
  outputPath: string | null,
  isExpanded: boolean,
  isRunning: boolean,
  fetcher?: (path: string) => Promise<BackgroundTaskOutput | null>,
): TaskOutputState {
  const [state, setState] = useState<TaskOutputState>({ content: '', size: 0, truncated: false, fetched: false });

  const poll = useCallback(async () => {
    if (!outputPath || !fetcher) return;
    try {
      const data = await fetcher(outputPath);
      if (!data) return;
      let content = data.content;
      let truncated = data.truncated;
      if (content.length > MAX_DISPLAY_CHARS) { content = content.slice(-MAX_DISPLAY_CHARS); truncated = true; }
      setState({ content, size: data.size, truncated, fetched: true });
    } catch { /* network error */ }
  }, [outputPath, fetcher]);

  useEffect(() => {
    if (!outputPath || !fetcher || !isExpanded) return;
    void poll();
    if (!isRunning) return;
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [outputPath, fetcher, isExpanded, isRunning, poll]);

  return state;
}

function countOutputLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').filter(line => line.trim()).length;
}

const AUTO_EXPAND_THRESHOLD = 5;

export function BashTool({ input, result: rawResult, isPending = false, fetchBackgroundOutput, backgroundState }: BashToolProps): React.JSX.Element {
  const result = stripRerunFooter(rawResult);
  const resultLines = countOutputLines(result);
  const [isExpanded, setIsExpanded] = useState(() => !isPending && resultLines > 0 && resultLines <= AUTO_EXPAND_THRESHOLD);

  const command = useMemo(() => unwrapShellCommand(input?.command || ''), [input?.command]);
  const description = input?.description || '';
  const bgOutputPath = useMemo(() => parseBackgroundOutputPath(result), [result]);
  const isBackgroundRunning = !!bgOutputPath && backgroundState === 'running';
  const taskOutput = useBackgroundTaskOutput(bgOutputPath, isExpanded, isBackgroundRunning, fetchBackgroundOutput);

  const displayOutput = bgOutputPath && taskOutput.content ? taskOutput.content : result;
  const displayCommand = useMemo(() => summarizeCommand(command), [command]);

  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (outputRef.current && isExpanded && bgOutputPath) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [taskOutput.content, isExpanded, bgOutputPath]);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.orange.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2 shrink-0">
            {isBackgroundRunning && <Loader2 size={12} className={`${accent.orange.icon} animate-spin`} />}
            <Terminal size={14} className={accent.orange.icon} />
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>
            {description || displayCommand}
          </span>
          {bgOutputPath && backgroundState === 'lost' && (
            <span className={`text-[10px] uppercase tracking-wider ${accent.red.icon} shrink-0`}>Lost</span>
          )}
        </>
      )}
      content={(
        <>
          {command && (
            <div className={`border-t ${tk.separator} ${tk.codeBg} px-3 py-2.5`}>
              <div className="flex gap-2">
                <span className="text-emerald-400/60 font-mono text-[13px] select-none shrink-0 leading-relaxed">$</span>
                <ShellHighlight code={formatShellCommand(command)} />
              </div>
            </div>
          )}
          {bgOutputPath && taskOutput.content && (
            <div className={`border-t ${tk.separator} ${tk.codeBg} px-3 py-2.5 max-h-96 overflow-auto`} ref={outputRef}>
              {taskOutput.truncated && (
                <div className={`text-[13px] ${tk.text.faint} mb-1`}>
                  … showing last {(MAX_DISPLAY_CHARS / 1000).toFixed(0)}K chars
                </div>
              )}
              <PlainOutput code={taskOutput.content} />
            </div>
          )}
          {bgOutputPath && backgroundState === 'running' && !taskOutput.content && (
            <div className={`border-t ${tk.separator} px-3 py-2 text-[13px] ${tk.text.muted} ${tk.codeBgSubtle} flex items-center gap-2`}>
              <Loader2 size={12} className="animate-spin" />
              <span>{fetchBackgroundOutput ? 'Waiting for output…' : 'Running in the background…'}</span>
            </div>
          )}
          {bgOutputPath && backgroundState === 'finished' && !taskOutput.content && (
            <div className={`border-t ${tk.separator} px-3 py-2 text-[13px] ${tk.text.muted} ${tk.codeBgSubtle}`}>
              {taskOutput.fetched ? 'Finished with no output.' : 'Finished in the background.'}
            </div>
          )}
          {bgOutputPath && backgroundState === 'lost' && (
            <div className={`border-t ${tk.separator} px-3 py-2 text-[13px] ${accent.red.icon} ${tk.codeBgSubtle}`}>
              Lost before it finished: the process running it went away, so its result will not arrive.
            </div>
          )}
          {!bgOutputPath && result && (() => {
            const [formatted, lang] = detectAndFormat(result);
            return (
              <div className={`border-t ${tk.separator} ${tk.codeBg} px-3 py-2.5`}>
                {lang === 'json'
                  ? <ShellHighlight code={formatted} lang={lang} />
                  : <PlainOutput code={formatted} />}
              </div>
            );
          })()}
          {!bgOutputPath && !result && isPending && (
            <div className={`border-t ${tk.separator} px-3 py-2 text-[13px] ${tk.text.muted} ${tk.codeBgSubtle}`}>
              Waiting for stdout...
            </div>
          )}
        </>
      )}
    />
  );
}
