/**
 * Feedback drafts and sending them to the collector.
 *
 * Every piece of feedback starts as a local draft, whether a person wrote it
 * or an agent proposed it with `lattice feedback`. Nothing leaves the machine
 * until someone presses Send in the Lattice page. The collector no longer
 * checks each message for a person: the user passes its bot check once, the
 * install gets a key, and from then on the rule that a person sends each
 * message is this server's. Only the send route, which answers browser pages
 * alone, uses the key, and it sends the draft at the revision the user saw.
 *
 * Drafts, the install ID and the per-session references are kept per
 * collector origin: changing the destination leaves old drafts behind, able
 * only to be deleted, rather than forwarding them somewhere new.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_DIR } from '@/utils/constants.js';
import { parseJson } from '@/utils/json.js';
import type { FeedbackConfig } from '@/types/config.js';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_SCREENS,
  type FeedbackCategory,
  type FeedbackContext,
  type FeedbackDraftView,
  type FeedbackPayload,
  type FeedbackProposalView,
  type FeedbackProvider,
  type FeedbackReceipt,
  type FeedbackRegistration,
  type FeedbackScope,
  type FeedbackScreen,
  type FeedbackSendError,
  type FeedbackSendResult,
  type FeedbackSource,
  type FeedbackStatus,
} from '@/types/feedback.js';

/**
 * The collector this build sends to unless `feedback.collectorUrl` says
 * otherwise. Placeholder until the official collector is deployed.
 */
export const DEFAULT_FEEDBACK_COLLECTOR_URL = 'https://lattice-feedback.liggi-lattice.workers.dev';

/** Pending agent proposals per install, and per session. */
const AGENT_DRAFT_LIMIT = 5;
const AGENT_DRAFTS_PER_SESSION = 1;
/** The collector refuses bodies over 16 KiB. */
const PAYLOAD_BYTE_LIMIT = 15 * 1024;
const SEND_TIMEOUT_MS = 15_000;
const MODEL_PATTERN = /^[A-Za-z0-9._[\]-]{1,100}$/;
/** What became of a draft is kept as long as the collector keeps the items. */
const RESOLVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class FeedbackError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

interface StoredDraft {
  id: string;
  origin: string;
  source: FeedbackSource;
  category: FeedbackCategory;
  message: string;
  scope: FeedbackScope;
  screen: FeedbackScreen;
  conversationId: string | null;
  sessionRef: string | null;
  provider: FeedbackProvider | null;
  model: string | null;
  latticeVersion: string;
  submissionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastError: FeedbackSendError | null;
}

/** A draft that was sent or thrown away, so its card can say which. */
interface ResolvedRecord {
  draftId: string;
  origin: string;
  outcome: 'sent' | 'rejected';
  category: FeedbackCategory;
  message: string;
  receipt: FeedbackReceipt | null;
  at: string;
}

/** The key the collector issued this install after its one-time check. Never leaves this server. */
interface InstallKey {
  installId: string;
  key: string;
  createdAt: string;
}

interface FeedbackState {
  installs: Record<string, string>;
  keys: Record<string, InstallKey>;
  sessionRefs: Record<string, Record<string, string>>;
  drafts: StoredDraft[];
  resolved: ResolvedRecord[];
}

export interface NewDraftInput {
  source: FeedbackSource;
  category?: string;
  message: string;
  conversationId?: string | null;
  screen?: string;
}

export interface ConversationLookup {
  (conversationId: string): { provider: string | null; model: string | null } | null;
}

/** The collector's origin, or why the URL cannot be one. */
export function collectorOriginOf(url: string): { origin: string } | { problem: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: `Not a URL: ${url}` };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return { problem: 'The feedback collector must use https (plain http only on this machine).' };
  }
  if (parsed.username || parsed.password) return { problem: 'The collector URL must not carry a username or password.' };
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { problem: 'The collector URL is a base address only, like https://feedback.example.com' };
  }
  return { origin: parsed.origin };
}

let cachedVersion: string | null = null;

/** This install's package version, as the collector accepts it. */
export function latticeVersion(): string {
  if (cachedVersion) return cachedVersion;
  let version = 'unknown';
  try {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const raw = (parseJson(fs.readFileSync(pkgPath, 'utf-8')) as { version?: unknown }).version;
    if (typeof raw === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(raw)) version = raw;
  } catch {
    // Left as 'unknown': the version is context for the reader, not a key.
  }
  cachedVersion = version;
  return version;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The collector's own sentence, with its wait turned into minutes. */
function collectorMessage(response: Response, body: Record<string, unknown>): string {
  const message = typeof body.message === 'string'
    ? body.message
    : `The feedback service answered ${response.status} without an explanation.`;
  const retryAfter = typeof body.retry_after_seconds === 'number' ? body.retry_after_seconds : null;
  if (!retryAfter) return message;
  // The collector's own "Try again later." is replaced by when.
  return `${message.replace(/\s*Try again later\.?$/, '')} Try again in ${Math.ceil(retryAfter / 60)} min.`;
}

function normaliseProvider(provider: string | null | undefined): FeedbackProvider | null {
  if (!provider) return null;
  return provider === 'claude' || provider === 'codex' ? provider : 'other';
}

function normaliseModel(model: string | null | undefined): string | null {
  return model && MODEL_PATTERN.test(model) ? model : null;
}

function validateMessage(message: unknown): string {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new FeedbackError('The feedback message is empty.', 400, 'invalid_message');
  }
  const length = [...message].length;
  if (length > FEEDBACK_MESSAGE_MAX) {
    throw new FeedbackError(
      `The feedback message is ${length} characters; the limit is ${FEEDBACK_MESSAGE_MAX}. Shorten it; nothing is cut off automatically.`,
      400,
      'message_too_long',
    );
  }
  return message;
}

function validateCategory(category: unknown): FeedbackCategory {
  if (category === undefined) return 'other';
  if (typeof category === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(category)) {
    return category as FeedbackCategory;
  }
  throw new FeedbackError(`Category must be one of: ${FEEDBACK_CATEGORIES.join(', ')}.`, 400, 'invalid_category');
}

function validateScreen(screen: unknown, fallback: FeedbackScreen): FeedbackScreen {
  if (screen === undefined) return fallback;
  if (typeof screen === 'string' && (FEEDBACK_SCREENS as readonly string[]).includes(screen)) return screen as FeedbackScreen;
  throw new FeedbackError(`Screen must be one of: ${FEEDBACK_SCREENS.join(', ')}.`, 400, 'invalid_screen');
}

export class FeedbackService {
  private readonly statePath: string;

  constructor(
    private readonly getConfig: () => FeedbackConfig | undefined,
    private readonly lookupConversation: ConversationLookup,
    private readonly hasInbox: () => boolean,
    dir: string = path.join(CONFIG_DIR, 'feedback'),
    private readonly fetchImpl: typeof fetch = fetch,
    /** Told about each agent proposal about a session, to put its card in the chat. */
    private readonly onAgentProposal: (draft: FeedbackDraftView) => void = () => {},
  ) {
    this.statePath = path.join(dir, 'state.json');
  }

  // -- Settings ------------------------------------------------------------

  collectorUrl(): string {
    return this.getConfig()?.collectorUrl?.trim() || DEFAULT_FEEDBACK_COLLECTOR_URL;
  }

  private currentOrigin(): string | null {
    const result = collectorOriginOf(this.collectorUrl());
    return 'origin' in result ? result.origin : null;
  }

  status(): FeedbackStatus {
    const config = this.getConfig();
    const originResult = collectorOriginOf(this.collectorUrl());
    const origin = 'origin' in originResult ? originResult.origin : null;
    const state = this.load();
    const pending = state.drafts.filter((draft) => draft.origin === origin);
    return {
      enabled: config?.enabled !== false,
      collectorUrl: this.collectorUrl(),
      collectorOrigin: origin,
      collectorProblem: 'problem' in originResult ? originResult.problem : null,
      pendingDrafts: pending.length,
      pendingAgentDrafts: pending.filter((draft) => draft.source === 'agent').length,
      inbox: this.hasInbox(),
      registered: origin !== null && state.keys[origin] !== undefined,
    };
  }

  /** Whether this install has a key, so a send needs no check first. */
  isRegistered(): boolean {
    const origin = this.currentOrigin();
    return origin !== null && this.load().keys[origin] !== undefined;
  }

  private requireUsableOrigin(): string {
    const result = collectorOriginOf(this.collectorUrl());
    if ('problem' in result) throw new FeedbackError(result.problem, 400, 'collector_url_invalid');
    return result.origin;
  }

  /** The origin to send to, refusing when feedback is off or the URL is unusable. */
  private requireSendableOrigin(): string {
    if (this.getConfig()?.enabled === false) {
      throw new FeedbackError(
        'Feedback is switched off in this Lattice, in Settings → General. Nothing was saved.',
        403,
        'feedback_disabled',
      );
    }
    const result = collectorOriginOf(this.collectorUrl());
    if ('problem' in result) throw new FeedbackError(result.problem, 400, 'collector_url_invalid');
    return result.origin;
  }

  // -- State file ----------------------------------------------------------

  private load(): FeedbackState {
    try {
      const parsed = parseJson(fs.readFileSync(this.statePath, 'utf-8')) as Partial<FeedbackState>;
      return {
        installs: parsed.installs ?? {},
        keys: parsed.keys ?? {},
        sessionRefs: parsed.sessionRefs ?? {},
        drafts: parsed.drafts ?? [],
        resolved: parsed.resolved ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installs: {}, keys: {}, sessionRefs: {}, drafts: [], resolved: [] };
      throw error;
    }
  }

  private save(state: FeedbackState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.statePath);
  }

  private installId(state: FeedbackState, origin: string): string {
    state.installs[origin] ??= crypto.randomUUID();
    return state.installs[origin];
  }

  private sessionRef(state: FeedbackState, origin: string, conversationId: string): string {
    const refs = (state.sessionRefs[origin] ??= {});
    refs[conversationId] ??= crypto.randomUUID();
    return refs[conversationId];
  }

  // -- Drafts --------------------------------------------------------------

  private payloadOf(state: FeedbackState, draft: StoredDraft): FeedbackPayload {
    return {
      schema_version: 1,
      submission_id: draft.submissionId,
      install_id: this.installId(state, draft.origin),
      source: draft.source,
      category: draft.category,
      message: draft.message,
      scope: draft.scope,
      screen: draft.screen,
      session_ref: draft.sessionRef,
      lattice_version: draft.latticeVersion,
      provider: draft.provider,
      model: draft.model,
    };
  }

  private view(state: FeedbackState, draft: StoredDraft, origin: string | null): FeedbackDraftView {
    const payload = this.payloadOf(state, draft);
    return {
      id: draft.id,
      source: draft.source,
      category: draft.category,
      message: draft.message,
      scope: draft.scope,
      conversationId: draft.conversationId,
      revision: draft.revision,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      collectorOrigin: draft.origin,
      sendable: draft.origin === origin,
      payload,
      lastError: draft.lastError,
    };
  }

  private assertFits(state: FeedbackState, draft: StoredDraft): void {
    const bytes = Buffer.byteLength(JSON.stringify(this.payloadOf(state, draft)), 'utf8');
    if (bytes > PAYLOAD_BYTE_LIMIT) {
      throw new FeedbackError(
        `The feedback is ${bytes} bytes; the limit is ${PAYLOAD_BYTE_LIMIT}. Shorten it; nothing is cut off automatically.`,
        400,
        'message_too_long',
      );
    }
  }

  /** What a draft would carry besides its text, for the form to show. */
  context(conversationId: string | null): FeedbackContext {
    const origin = this.requireSendableOrigin();
    const state = this.load();
    const installId = this.installId(state, origin);
    const conversation = conversationId ? this.lookupConversation(conversationId) : null;
    if (conversationId && !conversation) throw new FeedbackError(`No session ${conversationId}.`, 404, 'unknown_session');
    const sessionRef = conversationId ? this.sessionRef(state, origin, conversationId) : null;
    this.save(state);
    return {
      installId,
      latticeVersion: latticeVersion(),
      collectorOrigin: origin,
      scope: conversationId ? 'session' : 'app',
      sessionRef,
      provider: normaliseProvider(conversation?.provider),
      model: normaliseModel(conversation?.model),
    };
  }

  listDrafts(): FeedbackDraftView[] {
    const state = this.load();
    const origin = this.currentOrigin();
    const views = state.drafts.map((draft) => this.view(state, draft, origin));
    this.save(state);
    return views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getDraft(id: string): FeedbackDraftView {
    const state = this.load();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) throw new FeedbackError(`No feedback draft ${id}.`, 404, 'unknown_draft');
    return this.view(state, draft, this.currentOrigin());
  }

  createDraft(input: NewDraftInput): FeedbackDraftView {
    const origin = this.requireSendableOrigin();
    const message = validateMessage(input.message);
    const category = validateCategory(input.category);
    const conversationId = input.conversationId || null;
    const conversation = conversationId ? this.lookupConversation(conversationId) : null;
    if (conversationId && !conversation) throw new FeedbackError(`No session ${conversationId}.`, 404, 'unknown_session');
    const screen = validateScreen(input.screen, input.source === 'agent' ? 'cli' : conversationId ? 'conversation' : 'home');

    const state = this.load();
    if (input.source === 'agent') {
      const pending = state.drafts.filter((draft) => draft.origin === origin && draft.source === 'agent');
      if (pending.length >= AGENT_DRAFT_LIMIT) {
        throw new FeedbackError(
          `There are already ${pending.length} agent feedback drafts waiting for the user to review; the limit is ${AGENT_DRAFT_LIMIT}. Nothing was saved.`,
          409,
          'agent_draft_limit',
        );
      }
      if (conversationId && pending.filter((draft) => draft.conversationId === conversationId).length >= AGENT_DRAFTS_PER_SESSION) {
        throw new FeedbackError(
          'This session already has a feedback draft waiting for the user to review. Nothing was saved; the user can edit that draft in Lattice.',
          409,
          'session_draft_exists',
        );
      }
    }

    const now = new Date().toISOString();
    const draft: StoredDraft = {
      id: `fbd-${crypto.randomBytes(6).toString('hex')}`,
      origin,
      source: input.source,
      category,
      message,
      scope: conversationId ? 'session' : 'app',
      screen,
      conversationId,
      sessionRef: conversationId ? this.sessionRef(state, origin, conversationId) : null,
      provider: normaliseProvider(conversation?.provider),
      model: normaliseModel(conversation?.model),
      latticeVersion: latticeVersion(),
      submissionId: crypto.randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.assertFits(state, draft);
    state.drafts.push(draft);
    this.save(state);
    const view = this.view(state, draft, origin);
    if (draft.source === 'agent' && draft.conversationId) this.onAgentProposal(view);
    return view;
  }

  /** An edit is a new payload: new revision, new submission ID, old approval void. */
  updateDraft(id: string, changes: { category?: string; message?: string }): FeedbackDraftView {
    const state = this.load();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) throw new FeedbackError(`No feedback draft ${id}.`, 404, 'unknown_draft');
    const origin = this.currentOrigin();
    if (draft.origin !== origin) {
      throw new FeedbackError('This draft was made for a different feedback destination and can only be deleted.', 409, 'destination_changed');
    }
    const category = changes.category === undefined ? draft.category : validateCategory(changes.category);
    const message = changes.message === undefined ? draft.message : validateMessage(changes.message);
    if (category === draft.category && message === draft.message) return this.view(state, draft, origin);
    Object.assign(draft, {
      category,
      message,
      revision: draft.revision + 1,
      submissionId: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      lastError: null,
    });
    this.assertFits(state, draft);
    this.save(state);
    return this.view(state, draft, origin);
  }

  /** Throw a draft away unsent; an agent's card then reads "Feedback not sent". */
  deleteDraft(id: string): void {
    const state = this.load();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) throw new FeedbackError(`No feedback draft ${id}.`, 404, 'unknown_draft');
    state.drafts = state.drafts.filter((candidate) => candidate.id !== id);
    if (draft.source === 'agent') this.resolve(state, draft, 'rejected', null);
    this.save(state);
  }

  private resolve(state: FeedbackState, draft: StoredDraft, outcome: ResolvedRecord['outcome'], receipt: FeedbackReceipt | null): void {
    state.resolved = state.resolved.filter((record) => Date.now() - Date.parse(record.at) < RESOLVED_RETENTION_MS);
    state.resolved.push({
      draftId: draft.id,
      origin: draft.origin,
      outcome,
      category: draft.category,
      message: draft.message,
      receipt,
      at: new Date().toISOString(),
    });
  }

  /** An agent proposal as its card shows it. */
  proposal(id: string): FeedbackProposalView {
    const state = this.load();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (draft) return { state: 'pending', draft: this.view(state, draft, this.currentOrigin()) };
    const record = state.resolved.find((candidate) => candidate.draftId === id);
    if (!record) return { state: 'gone' };
    return record.outcome === 'sent'
      ? { state: 'sent', category: record.category, message: record.message, at: record.at }
      : { state: 'rejected', at: record.at };
  }

  // -- One-time check --------------------------------------------------------

  /** The install the collector's check registers; made on first use. */
  registration(): FeedbackRegistration {
    const origin = this.requireUsableOrigin();
    const state = this.load();
    const installId = this.installId(state, origin);
    this.save(state);
    return { installId, collectorOrigin: origin };
  }

  /**
   * Trade the ticket from the collector's bot check for this install's key.
   * The key goes into the state file and nowhere else: not to the page, not
   * to logs, not to agents' environments.
   */
  async register(ticket: unknown): Promise<void> {
    if (typeof ticket !== 'string' || !ticket) throw new FeedbackError('Missing verification ticket.', 400, 'missing_ticket');
    const origin = this.requireUsableOrigin();
    const state = this.load();
    const installId = this.installId(state, origin);
    this.save(state);

    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}/v1/installs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ install_id: installId, ticket }),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FeedbackError(`Could not reach the feedback service (${error instanceof Error ? error.message : String(error)}).`, 502, 'network');
    }
    const body = await readBody(response);
    if (response.status === 201 && typeof body.install_key === 'string' && body.install_id === installId) {
      const latest = this.load();
      latest.keys[origin] = {
        installId,
        key: body.install_key,
        createdAt: typeof body.created_at === 'string' ? body.created_at : new Date().toISOString(),
      };
      this.save(latest);
      return;
    }
    throw new FeedbackError(collectorMessage(response, body), response.ok ? 502 : response.status, typeof body.error === 'string' ? body.error : `http_${response.status}`);
  }

  // -- Sending -------------------------------------------------------------

  /**
   * Send the draft exactly as it stood at `revision`, the one the user was
   * shown when they pressed Send. Answers `verification_required` when the
   * install has no key, or the collector no longer accepts it; the page runs
   * the one-time check and tries again.
   */
  async send(id: string, revision: unknown): Promise<FeedbackSendResult> {
    const origin = this.requireSendableOrigin();
    const state = this.load();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) throw new FeedbackError(`No feedback draft ${id}.`, 404, 'unknown_draft');
    if (draft.origin !== origin) {
      throw new FeedbackError('This draft was made for a different feedback destination and can only be deleted.', 409, 'destination_changed');
    }
    if (draft.revision !== revision) {
      throw new FeedbackError('The draft changed after you reviewed it. Review it again and send.', 409, 'draft_changed');
    }
    const installKey = state.keys[origin];
    if (!installKey || installKey.installId !== this.installId(state, origin)) {
      throw new FeedbackError('Sending needs the one-time check first.', 409, 'verification_required');
    }

    const payload = this.payloadOf(state, draft);
    const failure = (code: string, message: string): FeedbackSendResult => {
      draft.lastError = { code, message, at: new Date().toISOString() };
      this.save(state);
      return { sent: false, error: draft.lastError, draft: this.view(state, draft, origin) };
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}/v1/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${installKey.key}` },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      return failure('network', `Could not reach the feedback service (${error instanceof Error ? error.message : String(error)}).`);
    }

    const body = await readBody(response);
    if (response.ok && typeof body.id === 'string' && typeof body.received_at === 'string') {
      const receipt: FeedbackReceipt = { id: body.id, receivedAt: body.received_at };
      state.drafts = state.drafts.filter((candidate) => candidate.id !== draft.id);
      this.resolve(state, draft, 'sent', receipt);
      this.save(state);
      return { sent: true, receipt, duplicate: body.duplicate === true };
    }

    if (response.status === 401 && body.error === 'invalid_install_key') {
      // Revoked or unknown to the collector: forget it, and the page asks for the check again.
      delete state.keys[origin];
      draft.lastError = null;
      this.save(state);
      throw new FeedbackError('The feedback service needs the one-time check again.', 409, 'verification_required');
    }

    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    return failure(code, collectorMessage(response, body));
  }
}
