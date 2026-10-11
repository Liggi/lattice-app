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
    handle(name: string, fn: (payload: unknown, context: { conversationId: string; cardId: string }) => string | Promise<string>): void;
  };
}

export type LatticePluginActivate = (host: LatticePluginHost) => void | Promise<void>;

/** Lucide icons fit. */
export type LatticeIcon = ComponentType<{ size?: number | string; className?: string }>;

export interface LatticeWebHost {
  readonly id: string;
  /** A page at `/p/<id><path>`; Lattice draws the sidebar and a header titled `title`. */
  page(path: string, component: ComponentType, opts: { title: string }): void;
  /** A link at the top of the sidebar. `useBadge` is a hook, called on every render. */
  sidebarLink(link: { label: string; path: string; icon?: LatticeIcon; useBadge?: () => string | null }): void;
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
