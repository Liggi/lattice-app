/**
 * Voice page — one button, GPT Live alpha, full Lattice session tools.
 *
 * Transport: microphone and response audio go browser <-> OpenAI directly over
 * WebRTC. The Lattice server only brokers the one-time SDP exchange, so nothing
 * in this app sits in the audio path.
 *
 * Tools: the session is created with Responses delegation, so OpenAI runs a
 * backend model with Lattice's tools declared and hands the resulting function
 * calls back over the data channel. This page executes them against the local
 * API and returns the output; the backend model's answer is injected into the
 * live session and spoken without the voice model relaying it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, AudioLines, Loader2, Mic, Square, Volume2 } from 'lucide-react';
import { parseJson } from '@/utils/json';
import { DEFAULT_VOICE_INSTRUCTIONS } from './voice-live-protocol';
import { StatusMap, fetchFleetStatuses, runTool } from './voice-fleet';

type Phase =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'live'
  | 'closing'
  | 'closed'
  | 'error';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  transcript: string;
  done: boolean;
}

/** What a tool is doing, said the way the user would say it. */
const TOOL_ACTIVITY: Record<string, string> = {
  list_sessions: 'Checking your sessions',
  read_session: 'Reading that session',
  send_to_session: 'Sending that message',
  start_session: 'Starting a session',
};

interface LiveEvent {
  type?: string;
  session?: { id?: string };
  turn?: { id?: string; role?: string; transcript?: string };
  turn_id?: string;
  delta?: string;
  item?: {
    id?: string;
    type?: string;
    target?: string;
    call_id?: string;
    name?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  item_id?: string;
  arguments?: string;
  error?: { message?: string; code?: string };
}

const FALLBACK_WORKING_DIRECTORY = '~';

/** How often live session status is refreshed for the runtime. */
const FLEET_POLL_MS = 6000;

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Ready',
  requesting: 'Requesting microphone',
  connecting: 'Connecting',
  live: 'Live',
  closing: 'Closing',
  closed: 'Session ended',
  error: 'Error',
};

export function VoicePage(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activity, setActivity] = useState<string | null>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [workingDirectory, setWorkingDirectory] = useState(FALLBACK_WORKING_DIRECTORY);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const phaseRef = useRef<Phase>('idle');

  /** Newest live status, shared with the fast lane so it sees what the page sees. */
  const statusesRef = useRef<StatusMap>({});
  /** Mirror of `turns` so the act call can read them without waiting on render. */
  const turnsRef = useRef<Turn[]>([]);

  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());

  /** Voice has no scrollback, so every data-channel event is written to disk. */
  const logBufferRef = useRef<Array<{ at: string; direction: string; payload: unknown }>>([]);
  const logSessionIdRef = useRef<string | null>(null);

  const transition = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  /**
   * Protocol trace. Written to the session log, not rendered: the alpha's event
   * vocabulary is undocumented so it is worth keeping, but it is diagnostic
   * detail rather than something the user needs while talking.
   */
  const addProtocolEvent = (label: string) => {
    recordLog('note', label);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [statusResponse, configResponse] = await Promise.all([
          fetch('/api/voice/status'),
          fetch('/api/config'),
        ]);
        if (cancelled) return;

        const status = (await statusResponse.json()) as { ready?: boolean };
        setReady(Boolean(status.ready));

        if (configResponse.ok) {
          const config = (await configResponse.json()) as {
            server?: { defaultWorkingDirectory?: string };
            defaultWorkingDirectory?: string;
          };
          const dir =
            config.server?.defaultWorkingDirectory ?? config.defaultWorkingDirectory;
          if (dir) setWorkingDirectory(dir);
        }
      } catch {
        if (!cancelled) setReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const teardownTransport = useCallback(() => {
    for (const source of eventSourcesRef.current.values()) source.close();
    eventSourcesRef.current.clear();

    channelRef.current?.close();
    channelRef.current = null;

    peerRef.current?.close();
    peerRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  useEffect(() => teardownTransport, [teardownTransport]);

  // The act model needs the conversation synchronously when a delegation lands,
  // which is often the same tick a turn was written.
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const recordLog = (direction: 'in' | 'out' | 'note', payload: unknown) => {
    logBufferRef.current.push({
      at: new Date().toISOString(),
      direction,
      payload,
    });
  };

  const flushLog = useCallback(async () => {
    const sessionId = logSessionIdRef.current;
    const entries = logBufferRef.current;
    if (!sessionId || entries.length === 0) return;
    logBufferRef.current = [];
    try {
      await fetch('/api/voice/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, entries }),
      });
    } catch {
      // Losing diagnostics must never take down a live call.
      logBufferRef.current = [...entries, ...logBufferRef.current];
    }
  }, []);

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const timer = window.setInterval(() => void flushLog(), 5000);
    return () => {
      window.clearInterval(timer);
      void flushLog();
    };
  }, [phase, flushLog]);

  /**
   * Keep live status fresh for the runtime.
   *
   * Nothing is pushed into the call. An earlier version streamed a running
   * commentary of fleet changes into the model's context; it made the model
   * speak unprompted, and it built a picture that drifted out of step with what
   * the runtime reported. Until the plain ask-and-answer loop is right, the
   * model is told nothing it did not ask for.
   */
  const pollStatuses = async () => {
    statusesRef.current = await fetchFleetStatuses(25);
  };

  // The interval must call the newest closure, not the one captured when the
  // session went live, so the effect depends only on `phase`.
  const pollStatusesRef = useRef(pollStatuses);
  pollStatusesRef.current = pollStatuses;

  useEffect(() => {
    if (phase !== 'live') return undefined;
    void pollStatusesRef.current();
    const timer = window.setInterval(() => void pollStatusesRef.current(), FLEET_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  /**
   * Tool calls from the Live session.
   *
   * `call_id` and `name` are NOT on `response.function_call_arguments.done`,
   * despite the alpha docs showing them there — that event carries only
   * `arguments` and `item_id`. Both live on `response.output_item.added`, so
   * the two are joined by `item_id`.
   */
  const pendingCallsRef = useRef<Map<string, { callId: string; name: string }>>(new Map());

  const handleToolCall = async (itemId: string, args: string) => {
    const call = pendingCallsRef.current.get(itemId);
    if (!call) {
      addProtocolEvent(`tool:unmatched:${itemId.slice(0, 8)}`);
      return;
    }
    pendingCallsRef.current.delete(itemId);

    const startedAt = Date.now();
    setActivity(TOOL_ACTIVITY[call.name] ?? 'Looking that up');

    const output = await runTool(call.name, args, statusesRef.current, workingDirectory);
    setActivity(null);

    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') return;

    // The nested `item` shape is required; a flat call_id is rejected with
    // "Missing required parameter: 'item.call_id'".
    const payload = {
      type: 'delegation.function_call_output.create',
      event_id: `lattice_tool_${call.callId}`,
      item: { type: 'function_call_output', call_id: call.callId, output },
    };
    recordLog('out', payload);
    channel.send(JSON.stringify(payload));

    addProtocolEvent(`tool:${call.name}:${Date.now() - startedAt}ms:${output.length}chars`);
  };

  const upsertTurn = (
    id: string,
    role: 'user' | 'assistant',
    transcript: string,
    done: boolean,
  ) => {
    setTurns((current) => {
      const existing = current.find((turn) => turn.id === id);
      if (!existing) return [...current, { id, role, transcript, done }];
      return current.map((turn) =>
        turn.id === id ? { ...turn, role, transcript, done } : turn,
      );
    });
  };

  const handleLiveEvent = (message: LiveEvent) => {
    const type = message.type;
    if (!type) return;
    recordLog('in', message);
    addProtocolEvent(type);

    if (type === 'session.started') {
      transition('live');
      return;
    }

    if (type === 'session.closed') {
      transition('closed');
      teardownTransport();
      return;
    }

    if (type === 'turn.created' && message.turn?.id) {
      upsertTurn(
        message.turn.id,
        message.turn.role === 'user' ? 'user' : 'assistant',
        message.turn.transcript ?? '',
        false,
      );
      return;
    }

    if (type === 'turn.delta' && message.turn_id) {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === message.turn_id
            ? { ...turn, transcript: `${turn.transcript}${message.delta ?? ''}` }
            : turn,
        ),
      );
      return;
    }

    if (type === 'turn.done' && message.turn?.id) {
      upsertTurn(
        message.turn.id,
        message.turn.role === 'user' ? 'user' : 'assistant',
        message.turn.transcript ?? '',
        true,
      );
      return;
    }

    if (type === 'response.output_item.added' && message.item?.type === 'function_call') {
      const item = message.item;
      if (item.id && item.call_id && item.name) {
        pendingCallsRef.current.set(item.id, { callId: item.call_id, name: item.name });
        addProtocolEvent(`tool:called:${item.name}`);
      }
      return;
    }

    if (type === 'response.function_call_arguments.done' && message.item_id) {
      void handleToolCall(message.item_id, message.arguments ?? '{}');
      return;
    }

    if (type === 'error') {
      setError(
        message.error?.message ?? message.error?.code ?? 'The Live API returned an error.',
      );
      transition('error');
      teardownTransport();
    }
  };

  const startSession = async () => {
    teardownTransport();
    setError(null);
    setTurns([]);
    setActivity(null);
    setSoundBlocked(false);
    pendingCallsRef.current.clear();

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        'Microphone access needs a secure context. Open Lattice over its HTTPS tailnet URL, not plain http.',
      );
      transition('error');
      return;
    }

    transition('requesting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      transition('connecting');

      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      peer.addEventListener('track', (event) => {
        const [remoteStream] = event.streams;
        if (!remoteStream || !audioRef.current) return;
        audioRef.current.srcObject = remoteStream;
        audioRef.current.play().catch(() => setSoundBlocked(true));
      });

      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed') {
          setError('The WebRTC connection failed.');
          transition('error');
          teardownTransport();
        }
      });

      const channel = peer.createDataChannel('oai-events');
      channelRef.current = channel;
      channel.addEventListener('message', ({ data }) => {
        if (typeof data !== 'string') return;
        try {
          handleLiveEvent(parseJson(data) as LiveEvent);
        } catch {
          setError('Received an unreadable event from the Live API.');
          transition('error');
          teardownTransport();
        }
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('The browser did not produce an SDP offer.');

      // Status first: the roster baked into the instructions is only worth
      // having if it can say which sessions are actually running.
      statusesRef.current = await fetchFleetStatuses(25);
      const response = await fetch('/api/voice/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp,
          instructions: DEFAULT_VOICE_INSTRUCTIONS,
          statuses: statusesRef.current,
        }),
      });
      const broker = (await response.json()) as {
        sdp?: string;
        session_id?: string;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !broker.sdp) {
        throw new Error(broker.detail || broker.error || 'Session creation failed.');
      }

      logSessionIdRef.current =
        broker.session_id ?? `local-${Math.floor(Date.now() / 1000)}`;
      recordLog('note', {
        event: 'session.opened',
        sessionId: logSessionIdRef.current,
        instructions: DEFAULT_VOICE_INSTRUCTIONS,
      });

      await peer.setRemoteDescription({ type: 'answer', sdp: broker.sdp });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the session.');
      transition('error');
      teardownTransport();
    }
  };

  const endSession = () => {
    transition('closing');
    const channel = channelRef.current;
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'session.close' }));
      // Give Live a moment to answer with session.closed before tearing down.
      window.setTimeout(() => {
        if (phaseRef.current === 'closing') {
          transition('closed');
          teardownTransport();
        }
      }, 1500);
      return;
    }
    transition('closed');
    teardownTransport();
  };

  const busy = phase === 'requesting' || phase === 'connecting' || phase === 'closing';
  const active = phase === 'live';

  return (
    <div className="relative min-h-dvh overflow-y-auto bg-bg text-fg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex h-[52px] max-w-3xl items-center gap-3 px-4">
          <Link
            to="/"
            aria-label="Back to Lattice"
            className="rounded-sm p-1.5 text-fg-3 no-underline hover:bg-surface-2 hover:text-fg"
          >
            <ArrowLeft size={17} />
          </Link>
          <AudioLines size={17} className="text-fg-3" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-fg-3">
              Orchestrator
            </p>
            <h1 className="truncate text-base font-medium text-fg">Voice</h1>
          </div>
          <span
            className={[
              'text-xs font-medium',
              active ? 'text-accent' : 'text-fg-3',
            ].join(' ')}
          >
            {PHASE_LABEL[phase]}
          </span>
        </div>
      </header>

      <main className="relative mx-auto flex max-w-3xl flex-col gap-8 px-4 pb-16 pt-10">
        <div className="flex flex-col items-center gap-5">
          <button
            type="button"
            onClick={active ? endSession : startSession}
            disabled={busy || ready === false}
            data-voice-state={active ? 'live' : 'ready'}
            className={[
              'voice-orb flex h-36 w-36 items-center justify-center rounded-full border transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              // Resting colours match the breathe keyframes in global.css (ready = accent
              // invites the tap; live = rose, since the tap ends the session).
              active
                ? 'border-[rgb(var(--color-rose-rgb)/0.4)] bg-[rgb(var(--color-rose-rgb)/0.06)] text-rose-300'
                : 'border-[rgb(var(--color-cool-rgb)/0.35)] bg-[rgb(var(--color-cool-rgb)/0.05)] text-accent',
            ].join(' ')}
            aria-label={active ? 'End voice session' : 'Start voice session'}
          >
            {busy ? (
              <Loader2 size={40} className="animate-spin" />
            ) : active ? (
              <Square size={34} />
            ) : (
              <Mic size={40} />
            )}
          </button>

          <p className="text-xs text-fg-3">
            {active ? 'Tap to end' : 'Tap to talk'}
          </p>

          {/* One line about what it is doing. Replaces a raw list of tool calls
              — but silence during a lookup reads as broken, so it stays. */}
          <div className="flex h-5 items-center">
            {activity && (
              <span className="flex items-center gap-2 text-xs font-medium text-accent">
                <Loader2 size={11} className="animate-spin" />
                {activity}
              </span>
            )}
          </div>

          {ready === false && (
            <p className="max-w-sm text-center text-xs leading-relaxed text-amber-400">
              No GPT Live alpha key is configured, so the microphone will not connect.
            </p>
          )}

          {soundBlocked && (
            <p className="flex items-center gap-2 text-xs text-amber-400">
              <Volume2 size={13} />
              The browser blocked playback — tap the page to allow sound.
            </p>
          )}

          {error && (
            <p className="max-w-md text-center text-xs leading-relaxed text-rose-300">
              {error}
            </p>
          )}
        </div>

        {turns.length > 0 && (
          <section className="flex flex-col gap-4">
            <h2 className="text-xs font-medium text-fg-2">
              Transcript
            </h2>
            {turns.map((turn) => (
              <div key={turn.id} className="flex flex-col gap-1.5">
                <span
                  className={[
                    'text-xs font-medium',
                    turn.role === 'user' ? 'text-fg-3' : 'text-fg-2',
                  ].join(' ')}
                >
                  {turn.role === 'user' ? 'You' : 'Orchestrator'}
                </span>
                <p className="text-sm leading-relaxed text-fg">
                  {turn.transcript}
                </p>
              </div>
            ))}
          </section>
        )}

        {turns.length === 0 && !active && (
          <div className="rounded-lg border border-line bg-surface p-10 text-center">
            <p className="text-sm text-fg-2">
              Ask what your sessions are doing, drill into one, or send it an instruction.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-fg-3">
              On iPhone this needs the screen on and this tab in front — Safari suspends
              microphone capture in the background.
            </p>
          </div>
        )}
      </main>

      <audio ref={audioRef} autoPlay className="hidden" />
    </div>
  );
}
