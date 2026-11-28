/**
 * The contract between Lattice and a plugin.
 *
 * A plugin is a package installed under `<config dir>/plugins/node_modules`
 * and named in `config.json`'s `plugins`. Its package.json has a `lattice`
 * field (`LatticePluginManifest`). Lattice imports the server entry at startup
 * and calls its default export with a `LatticePluginHost`; the web app imports
 * the web entry at runtime and calls its default export with a
 * `LatticeWebHost`.
 *
 * A plugin runs with all of Lattice's access: install only what you trust.
 */

import type { Router } from 'express';
import type { ComponentType } from 'react';

export interface LatticePluginManifest {
  /** Lowercase letters, digits and dashes; names its routes, page paths and data folder. */
  id: string;
  /** The contract version the plugin was built for: 1. Lattice refuses any other. */
  api: number;
  /** Server entry, an ES module, relative to the package. */
  server?: string;
  /** Web entry, a single bundled ES module, relative to the package. */
  web?: string;
  /** Stylesheet the web app loads with the web entry. */
  css?: string;
}

export interface LatticePluginLog {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** What an agent sent with `lattice plugin <id> <command>`. */
export interface LatticePluginCommandInput {
  /** The conversation the agent named with --session. */
  session: string;
  /** Every other `--name value` flag, by name. */
  args: Record<string, string>;
  /** Standard input, verbatim; empty when nothing was piped. */
  text: string;
}

/** A skill Lattice gives the agents in its sessions, so they know when and how to use a plugin's commands. */
export interface LatticePluginSkill {
  /** Lowercase letters, digits and dashes; agents see it as `lattice:<name>` in Claude, `lattice-<name>` in Codex. */
  name: string;
  /** When an agent should use it, as a skill's description says it. */
  description: string;
  /** The instructions, in markdown. Name commands as `${host.cli} plugin <id> <name>`. */
  body: string;
}

export interface LatticeConfirmOption {
  label: string;
  /** What choosing it sets in motion, in one line. */
  consequence: string;
  recommended?: boolean;
}

export interface LatticeConfirmCard {
  /** One line: the ask. */
  question: string;
  /** Shown in full and exactly as given, line breaks kept, on the open and the answered card. */
  detail?: string;
  options: LatticeConfirmOption[];
  /** The label of the option whose choice runs the action. */
  runs: string;
  /**
   * A card view the plugin's web entry registers (`web.cardView`), drawn in
   * place of `detail` on the open and the answered card. `detail` is still
   * what the agent and the panel read.
   */
  view?: string;
}

/** What a confirm handler is told besides the payload. */
export interface LatticeConfirmContext {
  conversationId: string;
  cardId: string;
  /** Text the user edited in the card's view (`setEdit`) before choosing `runs`; absent when unedited. */
  edit?: string;
}

/** Keys the user saved with `lattice keys import` or in Settings that a plugin may read. */
export type LatticeKeyName = 'slack';

export type LatticeJobState =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface LatticeJobRecord {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  state: LatticeJobState;
  stateReason?: string | null;
  session?: string | null;
  project?: { id: string; name: string } | null;
  done: number;
  total: number | null;
  unit?: string;
  skipped?: number;
  failedCount?: number;
  stage?: string | null;
  stages?: Array<{ name: string; status: 'done' | 'active' | 'pending' }>;
  message?: string | null;
  startedAt: number;
  movedAt: number;
  updatedAt: number;
  endedAt?: number | null;
  ratePerMin?: number | null;
  etaAt?: number | null;
  etaGuess?: boolean;
  provenance?: string | null;
  command?: string | null;
  pid?: number | null;
  exitCode?: number | null;
  logTail?: string[];
  canStop?: boolean;
  externalUrl?: string | null;
  detailView?: { pluginId: string; view: string; payload?: unknown } | null;
}

export interface LatticeJobProviderSnapshot {
  jobs: LatticeJobRecord[];
  warning?: string | null;
}

export interface LatticeJobProvider {
  /** Short stable id, e.g. `'ci-runner'`. */
  id: string;
  /** Plain-English name shown in Running now (`CI runner`). */
  label: string;
  list(): Promise<LatticeJobProviderSnapshot>;
  stop?(jobId: string): Promise<void>;
  /** Optional push subscription: call `onChange` whenever this provider's jobs change; returns unsubscribe. */
  subscribe?(onChange: () => void): () => void;
}

export interface LatticeJobDetailViewProps {
  job: LatticeJobRecord;
  payload: unknown;
}

export interface LatticePluginHost {
  readonly id: string;
  /** `<config dir>/plugin-data/<id>`, created before `activate` runs. */
  readonly dataDir: string;
  readonly log: LatticePluginLog;
  /** Mounted at `/api/plugins/<id>`, behind Lattice's sign-in. */
  readonly router: Router;
  /** Runs when the server stops: clear timers, abort requests. */
  onStop(fn: () => void | Promise<void>): void;
  /**
   * Answers `lattice plugin <id> <name> --session <conv> [--flag value…]`.
   * The returned text is printed to the agent; a thrown error's message is
   * printed as the failure.
   */
  command(name: string, handler: (input: LatticePluginCommandInput) => string | Promise<string>): void;
  /**
   * How an agent runs Lattice's CLI, for the instructions a plugin gives it:
   * `${host.cli} plugin <id> <name>`, or `${host.cli} session search …`.
   * Agents' shells do not have `lattice` on PATH.
   */
  readonly cli: string;
  /**
   * Gives every Claude and Codex session Lattice starts a skill, beside the
   * ones Lattice ships. Call it from `activate`: skills are written once the
   * server has loaded its plugins, and a session reads them when it starts.
   * Keep anything that changes while Lattice runs out of the body, and have
   * the agent ask a command for it instead.
   */
  skill(skill: LatticePluginSkill): void;
  sessions: {
    /**
     * Starts a new conversation whose first message is `message`, on the
     * user's default model, named `title` in the sidebar if one is given.
     */
    create(opts: { message: string; title?: string; workingDirectory?: string; provider?: 'claude' | 'codex' }): Promise<{ conversationId: string }>;
  };
  confirm: {
    /**
     * Puts a card in the conversation. Choosing `card.runs` calls the handler
     * registered for `action.name` with `action.payload`, once; the payload is
     * kept with the card, so an answer after a restart still runs it. A card
     * still unanswered in that conversation is replaced (`replaced`).
     */
    ask(conversationId: string, card: LatticeConfirmCard, action: { name: string; payload: unknown }): { cardId: string; replaced: boolean };
    /**
     * The handler's returned text is added to the line the agent reads with
     * the answer. A thrown error tells the agent it failed, and the action can
     * run again from a new card.
     */
    handle(name: string, fn: (payload: unknown, context: LatticeConfirmContext) => string | Promise<string>): void;
  };
  keys: {
    /** The saved key, read fresh on each call, or null when none is saved. Never log or print it. */
    get(name: LatticeKeyName): string | null;
  };
  /** Feed external long-running jobs into Lattice's core Running now view. */
  jobs?: {
    registerProvider(provider: LatticeJobProvider): void;
  };
}

export type LatticePluginActivate = (host: LatticePluginHost) => void | Promise<void>;

/** Lucide icons fit. */
export type LatticeIcon = ComponentType<{ size?: number | string; className?: string }>;

/** What a card view (`web.cardView`) is drawn with. */
export interface LatticeCardViewProps {
  cardId: string;
  conversationId: string;
  /** The payload the server put on the card with `confirm.ask`. */
  payload: unknown;
  /** The card still takes an answer. */
  open: boolean;
  /** The option the user chose, or null. */
  answer: string | null;
  /** The action has run, and cannot run again. */
  actionRan: boolean;
  /** While open: text sent to the action as `context.edit` when the user chooses `runs`; undefined sends none. */
  setEdit(edit: string | undefined): void;
  /** While open: stops `runs` being chosen, with why, shown on the option; null allows it again. */
  blockRuns(reason: string | null): void;
}

/** Where a plugin's sidebar link sits: top rail, inside Inbox, collapsed under Tools or Experimental, or hidden. */
export type LatticeSidebarSection = 'top' | 'inbox' | 'tools' | 'experimental' | 'hidden';

export interface LatticeWebHost {
  readonly id: string;
  /** A page at `/p/<id><path>`; Lattice draws the sidebar and a header titled `title`. */
  page(path: string, component: ComponentType, opts: { title: string }): void;
  /** A link in the sidebar. `useBadge` is a hook, called on every render. */
  sidebarLink(link: { label: string; path: string; icon?: LatticeIcon; useBadge?: () => string | null; section?: LatticeSidebarSection }): void;
  /**
   * Draws the body of the plugin's confirm cards that name `name` as their
   * `view`, in the conversation, with the plugin's stylesheet applied.
   */
  cardView(name: string, component: ComponentType<LatticeCardViewProps>): void;
  /**
   * Draws an extra detail section inside Lattice's core Running now detail pane
   * for jobs whose `detailView` names this plugin and `name`.
   */
  jobDetailView?(name: string, component: ComponentType<LatticeJobDetailViewProps>): void;
  /** Requests to the plugin's own routes, `/api/plugins/<id><path>`; a non-2xx answer throws its `error`. */
  api: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
  };
  /** Moves the app to a path: `/c/<conversationId>` for a session, `pagePath()` for the plugin's pages. */
  navigate(to: string): void;
  /** The app path of one of this plugin's pages. */
  pagePath(path?: string): string;
}

export type LatticeWebActivate = (web: LatticeWebHost) => void;
