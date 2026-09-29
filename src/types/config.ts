/**
 * Configuration types for Lattice.
 */

// ============================================================
// Permission Modes - Single Source of Truth
// ============================================================
// Used by: ServerConfig type and route validation
// When updating, grep for PERMISSION_MODES to find all usages.

/** Canonical permission modes for Claude sessions */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];

export interface ServerConfig {
  host: string;
  port: number;
  /**
   * Token for API authentication. When set, all /api/* requests must include
   * `Authorization: Bearer <token>`; the web app asks for the token once and
   * holds a sign-in cookie instead. If unset, no auth is enforced.
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
   * 'bypassPermissions' = skip all prompts, 'plan' = plan only mode,
   * 'auto' = Claude Code's classifier decides, blocking risky actions
   */
  defaultPermissionMode?: PermissionMode;
  /**
   * Permission mode for a new Claude worker (a session started with
   * `pickedUpFrom`) that names none. Unset: 'auto'. Coordinators and
   * sessions started from the New screen never use it.
   */
  workerPermissionMode?: PermissionMode;
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
}

export interface ClaudeEndpointConfig {
  /** Stable handle the settings page edits by; the key is matched on it. */
  id: string;
  /** Where the Claude CLI sends requests, e.g. 'http://127.0.0.1:8080'. */
  baseUrl: string;
  /** The model the server serves. Picking it runs a session on this server; unique across endpoints. */
  model: string;
  /** Sent as a bearer token. Optional: many local servers take none. */
  apiKey?: string;
  /** Tokens the served model holds, passed as CLAUDE_CODE_MAX_CONTEXT_TOKENS so auto-compact runs in time. */
  contextWindow?: number;
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

export interface FeedbackConfig {
  /**
   * Whether this Lattice may send feedback. On unless set to false; even on,
   * nothing leaves the machine until the user presses Send, and false stops
   * agents saving drafts too.
   */
  enabled?: boolean;
  /**
   * The feedback collector's base URL. Unset uses the build's default. A fork
   * points this at its own collector; changing it strands drafts made for the
   * old one, which can then only be deleted.
   */
  collectorUrl?: string;
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
   * Anthropic API configuration (optional)
   * Used for session insights extraction with Opus 4.5
   */
  anthropic?: AnthropicConfig;

  /**
   * Anthropic-compatible servers, such as a local llama.cpp, that a Claude
   * session can run on instead of Anthropic by picking the server's model.
   * Other sessions keep the Claude sign-in.
   */
  claudeEndpoints?: ClaudeEndpointConfig[];

  /**
   * TypeSafe (Jev) configuration: the coordinator router's judge.
   */
  typesafe?: TypeSafeConfig;

  /**
   * The person using this Lattice, as agents refer to them.
   */
  user?: UserConfig;

  /**
   * Coordinator role settings.
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
   * Storage lifecycle policy for unified message store.
   */
  messageLifecycle?: MessageLifecycleConfig;

  /**
   * Background model-backed generation.
   */
  generation?: GenerationConfig;

  /**
   * Sending feedback to the Lattice maintainer's collector.
   */
  feedback?: FeedbackConfig;

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
