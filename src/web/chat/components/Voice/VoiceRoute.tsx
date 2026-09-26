/**
 * Gate for `/voice`.
 *
 * The voice orchestrator runs on the GPT Live alpha, which is confidential,
 * explicitly not for production traffic, and needs a separately enrolled key.
 * So it stays off unless `interface.voice` is set, and says how to turn it on
 * rather than 404ing — a blank page is indistinguishable from a broken build.
 */

import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { VoicePage } from './VoicePage';

export function VoiceRoute(): JSX.Element {
  const { voiceEnabled, isLoading } = usePreferencesContext();

  // Config arrives asynchronously; rendering the gate first would flash a
  // "disabled" screen on every load.
  if (isLoading) return <div className="min-h-dvh bg-bg" />;

  if (!voiceEnabled) {
    return (
      <div className="min-h-dvh bg-bg text-fg">
        <div className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
          <Link
            to="/"
            className="flex items-center gap-2 text-xs text-fg-3 no-underline transition-colors hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Lattice
          </Link>

          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
            <h1 className="text-sm font-medium text-fg">Voice is turned off</h1>
            <p className="text-[13px] leading-relaxed text-fg-2">
              It runs on the GPT Live alpha, which needs its own enrolled key and is
              not for production use. Enable it by setting{' '}
              <code className="font-mono text-[12px] text-fg">interface.voice</code>{' '}
              to <code className="font-mono text-[12px] text-fg">true</code> in{' '}
              Lattice's <code className="font-mono text-[12px] text-fg">config.json</code>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <VoicePage />;
}
