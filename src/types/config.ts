/**
 * Configuration types for Lattice.
 */

// ============================================================
// Permission Modes - Single Source of Truth
// ============================================================
// Used by: ServerConfig type and route validation
// When updating, grep for PERMISSION_MODES to find all usages.

/** Canonical permission modes for Claude sessions */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];

export interface ServerConfig {
  host: string;
  port: number;
  /**
   * Bearer token for API authentication. When set, all /api/* requests
   * must include `Authorization: Bearer <token>`. If unset, no auth is enforced.
   * Used by cloud deployments to restrict access to the provisioned user.
   */
  authToken?: string;

  /**
   * How Claude conversations are billed. `cli` (default): the Claude Code
   * sign-in on this machine, with whatever authentication the CLI itself has.
   * `api-key`: the key under `anthropic.apiKey`, handed only to the Claude
   * processes Lattice spawns. Separate from the key's presence so saving a key
   * for summaries never silently moves conversations onto API billing.
   */
  claudeAuthMode?: 'cli' | 'api-key';
  /**
   * Claude model for new sessions when none is picked. Unset or '' runs the
   * Claude CLI's own default.
   * Example: 'claude-opus-4-8'
   */
  defaultModel?: string;
  /**
   * Default working directory for new Claude sessions
   * Falls back to user's home directory if not specified
   */
  defaultWorkingDirectory?: string;
  /**
   * Default permission mode for new Claude sessions
   * 'default' = ask for permissions, 'acceptEdits' = auto-accept edits,
   * 'bypassPermissions' = skip all prompts, 'plan' = plan only mode
   */
  defaultPermissionMode?: PermissionMode;
  /**
   * Custom system prompt injected into all Claude sessions spawned by Claudia.
   * This is appended to Claude's default system prompt via --system-prompt.
   * Use this for global instructions, persona customization, or project context.
   */
  systemPrompt?: string;
}

export interface GeminiConfig {
  /**
   * Google API key for Gemini
   * Can also be set via GOOGLE_API_KEY environment variable
   */
  apiKey?: string;

  /**
   * Gemini model to use
   * Default: 'gemini-2.5-flash'
   */
  model?: string;
}

export interface OpenAIConfig {
  /**
   * OpenAI API key
   * Can also be set via OPENAI_API_KEY environment variable
   */
  apiKey?: string;

  /**
   * OpenAI model to use for cross-session synthesis and other high-judgment tasks.
   * Default: 'gpt-5.4'
   */
  model?: string;
}

export interface TypeSafeConfig {
  /**
   * TypeSafe API key (Jev, the criterion judge the coordinator router calls).
   * Can also be set via TYPESAFE_API_KEY, or read from `apiKeyFile` at call
   * time so the key never sits in config.json.
   */
  apiKey?: string;
  /** Path to a file holding the key alone; read on each call, never logged. */
  apiKeyFile?: string;
}

export interface CoordinatorConfig {
  /**
   * Provider a new coordinator starts on when the caller does not name one.
   * Default: 'codex'. See coordinator-defaults.ts.
   */
  provider?: 'claude' | 'codex';
  /**
   * Claude model a new coordinator starts on when it runs on Claude. Default:
   * server.defaultModel when set, else the Claude CLI's own default.
   */
  claudeModel?: string;
  /**
   * Codex model a new coordinator starts on, and the one a resume keeps it
   * on. Default: the standard Codex model. See coordinator-defaults.ts.
   */
  model?: string;
  /**
   * Codex reasoning effort for a coordinator. Default: 'medium' — a
   * coordinator reads and decides rather than implements, and the deepest
   * tier mostly adds waiting. Worker routing is separate.
   */
  reasoningEffort?: string;
  /**
   * The fast responder: answers a message that needs a reply while the
   * coordinator is mid-turn. Spend is
   * gated by `generation.coordinatorFastReply`.
   */
  fastReply?: {
    /** Anthropic model for the reply. Default: 'claude-sonnet-5'. */
    model?: string;
    /**
     * Jev score at or above which a message is routed to the fast responder.
     * Default from the 2026-09-20 calibration (see coordinator-router.ts).
     */
    threshold?: number;
  };
}

export interface AnthropicConfig {
  /**
   * Anthropic API key
   * Can also be set via ANTHROPIC_API_KEY environment variable
   */
  apiKey?: string;

  /**
   * Claude model to use for full insight generation (expensive, high quality)
   * @deprecated Use models.generation instead
   * Default: 'claude-sonnet-4-5-20250929'
   */
  model?: string;

  /**
   * Model configuration for the insights system.
   * Allows fine-tuning which models are used for different operations.
   * See DEFAULT_MODELS in anthropic-service.ts for actual defaults.
   */
  models?: {
    /** Full insight generation - needs high capability. Default: sonnet */
    generation?: string;
    /** Quick staleness checks - needs speed. Default: haiku */
    quickCheck?: string;
    /** Fast patch generation - speed over quality. Default: haiku */
    patch?: string;
    /** Full patch generation (fallback when fast path fails). Default: haiku */
    fullPatch?: string;
  };
}

export interface InterfaceConfig {
  colorScheme: 'light' | 'dark' | 'system';
  language: string;
  /**
   * Enable developer mode (shows prototypes, debug tools)
   * Only set to true on your local development machine
   */
  devMode?: boolean;
  /**
   * Enable the voice orchestrator (`/voice`).
   *
   * Off by default: it needs a GPT Live alpha key, and the alpha is explicitly
   * not for production traffic. Requires a secure context for the microphone,
   * so over the tailnet it must be the HTTPS host rather than plain http.
   */
  voice?: boolean;
  notifications?: {
    enabled: boolean;
    ntfyUrl?: string;
    webPush?: {
      subject?: string; // e.g. mailto:you@example.com
      vapidPublicKey?: string;
      vapidPrivateKey?: string;
    };
  };
}

export interface ElevenLabsConfig {
  /**
   * ElevenLabs API key for Conversational AI
   * Get from: https://elevenlabs.io/app/settings/api-keys
   */
  apiKey?: string;

  /**
   * ElevenLabs Agent ID (created in their dashboard)
   * Get from: https://elevenlabs.io/app/agents
   */
  agentId?: string;

  /** TTS voice ID. Default: George (JBFqnCBsd6RMkjVDRZzb, premade free-tier) */
  voiceId?: string;

  /** TTS model. Default: eleven_v3 (most expressive, supports audio tags) */
  model?: string;
}

export interface MessageLifecycleConfig {
  /**
   * Enable periodic archive job.
   */
  enabled?: boolean;
  /**
   * Move messages older than this threshold into archive tier.
   */
  hotRetentionDays?: number;
  /**
   * Compress newly archived payloads using gzip.
   */
  archiveCompression?: boolean;
  /**
   * Delete rows from hot store after successful archive copy.
   */
  pruneEnabled?: boolean;
  /**
   * Max messages processed per archive run.
   */
  batchSize?: number;
  /**
   * Scheduler interval in minutes.
   */
  intervalMinutes?: number;
}

/**
 * Delivery into a running turn (services/sessions/immediate-delivery.ts).
 *
 * On by default; the path costs no model call. Set `immediateDelivery: false`
 * and every message to a mid-turn session waits for the turn boundary in the
 * inbox instead.
 */
export interface MessagingConfig {
  immediateDelivery?: boolean;
}

export interface UserConfig {
  /** The name agents use for you in their instructions. Default: "the user". */
  name?: string;
  /** Standing guidance appended to every coordinator's instructions. */
  coordinatorGuidance?: string;
  /** Standing guidance appended to every worker's instructions. */
  workerGuidance?: string;
  /** Names of your projects, given to session summaries as project-name hints. */
  projects?: string[];
}

export interface LatticeConfig {
  /**
   * Server configuration
   */
  server: ServerConfig;

  /**
   * Gemini API configuration (optional)
   */
  gemini?: GeminiConfig;

  /**
   * OpenAI API configuration (optional)
   */
  openai?: OpenAIConfig;

  /**
   * GPT Live alpha configuration (optional)
   *
   * Deliberately separate from `openai` — Live alpha access is enrolled per
   * project key, so the key that works here is generally NOT the same key used
   * for cross-session synthesis. Overridden by OPENAI_LIVE_API_KEY.
   */
  openaiLive?: OpenAIConfig;

  /**
   * Anthropic API configuration (optional)
   * Used for session insights extraction with Opus 4.5
   */
  anthropic?: AnthropicConfig;

  /**
   * TypeSafe (Jev) configuration: the coordinator router's judge.
   */
  typesafe?: TypeSafeConfig;

  /**
   * The person using this Lattice, as agents refer to them.
   */
  user?: UserConfig;

  /**
   * Coordinator role settings (router + fast responder).
   */
  coordinator?: CoordinatorConfig;

  /**
   * How messages reach a session that is already in a turn.
   */
  messaging?: MessagingConfig;

  /**
   * Interface preferences and settings
   */
  interface: InterfaceConfig;

  /**
   * ElevenLabs Conversational AI configuration
   */
  elevenlabs?: ElevenLabsConfig;

  /**
   * Storage lifecycle policy for unified message store.
   */
  messageLifecycle?: MessageLifecycleConfig;

  /**
   * Background model-backed generation.
   */
  generation?: GenerationConfig;

  /**
   * Plugin packages to load (npm package names)
   * e.g., ['my-lattice-plugin']
   */
  plugins?: string[];
}

/**
 * Switches for every feature that spends money on a provider API key.
 *
 * All default OFF, which is a reversal. The reason, measured against
 * `llm_costs` on one machine on 2026-08-28: $12,371 of Anthropic spend
 * since March, none of it visible anywhere in the product.
 *
 * The shape of that number is the argument for defaulting closed. Session
 * summaries alone were $9,259 — but summarising each session once would have
 * cost $120. The other 98.7% went on re-summarising sessions that already had
 * a summary, because a completed summary becomes a candidate again the moment
 * the session logs another event, so an active session is rewritten every 30
 * minutes for as long as it stays active. One session was regenerated 1,457
 * times. Nothing in the code was wrong in an obvious way and nothing failed;
 * it just ran.
 *
 * So the default is not a judgement about whether these features are good. It
 * is that a metered key plus a scheduled loop plus no spend display is a
 * combination that can lose thousands of dollars without producing a single
 * error, and the only reliable defence is that nothing bills until it is
 * asked to.
 *
 * ConfigService watches config.json, so flipping any of these takes effect on
 * the next call with no restart — which matters when the thing being switched
 * is spending right now.
 */
export interface GenerationConfig {
  // -- Background work: runs on Lattice's clock, nobody waiting on it --------

  /** Per-session narrative summaries (SessionSummaryService scheduled tick). */
  sessionSummary?: boolean;
  /**
   * Session insights — the GENERATE / QUICK_CHECK / PATCH family. Fires on
   * every turn:end and backfills on conversation-list load, so it scales with
   * how much you use Lattice rather than with anything you asked for.
   * Gating this stops new insights being computed; already-cached insights
   * still render.
   */
  insights?: boolean;
  /** Per-turn capture summaries (TurnCaptureService). Dormant since 2026-07-08. */
  turnCapture?: boolean;
  /** LLM-suggested permission patterns on the approval prompt. */
  permissionPatterns?: boolean;

  // -- Request-triggered: needs a click, but the click is cheap to make -----

  /** Session reviews (SessionReviewService), incl. its Gemini second opinion. */
  sessionReview?: boolean;
  /** Gemini consultation and generated session images (GeminiService). */
  gemini?: boolean;
  /**
   * Voice mode's act model (OpenAI /v1/responses) and the Live session it
   * drives. Untracked by the cost tracker — Lattice records Anthropic spend
   * only, so OpenAI and Gemini usage has never been measured here at all.
   */
  voice?: boolean;
  /**
   * The coordinator router (one Jev call per message that reaches a busy
   * coordinator) and the fast responder it feeds (one Anthropic call when
   * the router says the message needs a reply now). Off: a busy
   * coordinator's messages wait for its next turn, as before.
   */
  coordinatorFastReply?: boolean;
  /**
   * The worker activity line (one short model-written phrase per worker card,
   * from that worker's own work evidence). Off: cards show the task and the
   * lifecycle word alone, as before.
   */
  workerActivity?: boolean;
  /**
   * The summary at the top of a worker's report card (one model call per
   * report, from the report alone). Off: the card shows the report itself,
   * clipped to a few lines and expandable, as before.
   */
  workerReportSummary?: boolean;
  /**
   * A project's short sidebar title, written once from the outcome the
   * coordinator has agreed with the user. Unlike the insight mission it does
   * not follow the transcript: nothing regenerates it while the project makes
   * ordinary progress, so the bill is one call per outcome change. Off:
   * projects fall back to the insight mission, which renames itself as the
   * work moves.
   */
  projectName?: boolean;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: LatticeConfig = {
  server: {
    // An IPv4 literal, not `localhost`: Node resolves `localhost` to ::1 on
    // macOS, and the CLI and hooks dial 127.0.0.1.
    host: '127.0.0.1',
    port: 3001
  },
  interface: {
    colorScheme: 'system',
    language: 'en'
  },
  messageLifecycle: {
    enabled: false,
    hotRetentionDays: 120,
    archiveCompression: false,
    pruneEnabled: false,
    batchSize: 500,
    intervalMinutes: 60,
  },
};
