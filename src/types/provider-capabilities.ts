import type { Provider } from './unified-messages.js';

export type ApprovalCapability = 'interactive' | 'fixed-never' | 'unsupported';
export type BranchingCapability = 'history-copy' | 'native-fork' | 'unsupported';

export interface ProviderCapabilities {
  attachments: {
    image: boolean;
    text: boolean;
    pdf: boolean;
  };
  interactiveQuestions: boolean;
  approvals: ApprovalCapability;
  goals: boolean;
  branching: BranchingCapability;
  modelSwitching: {
    model: boolean;
    reasoningEffort: boolean;
  };
}

/**
 * Product-facing provider contract.
 *
 * Keep provider differences here instead of scattering `provider === ...`
 * gates through the UI. This describes what Lattice actually wires today,
 * not everything the underlying provider protocol could theoretically do.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<Provider, ProviderCapabilities>> = {
  claude: {
    attachments: { image: true, text: true, pdf: true },
    interactiveQuestions: true,
    approvals: 'interactive',
    goals: false,
    branching: 'history-copy',
    // Model and `--effort` apply on the next idle turn via respawn-with-resume.
    modelSwitching: { model: true, reasoningEffort: true },
  },
  codex: {
    attachments: { image: true, text: true, pdf: false },
    interactiveQuestions: true,
    // Codex is launched with approvalPolicy=never. Lattice explicitly declines
    // unexpected approval requests instead of surfacing an inert prompt.
    approvals: 'fixed-never',
    goals: true,
    // The installed app-server supports thread/fork, but Lattice still needs
    // to re-key its event history before the resulting branch is usable.
    branching: 'unsupported',
    modelSwitching: { model: true, reasoningEffort: true },
  },
  opencode: {
    attachments: { image: true, text: true, pdf: false },
    // The server exposes question/{requestID}/reply, but Lattice does not
    // subscribe to question requests yet.
    interactiveQuestions: false,
    // opencode's server owns approval policy through its own agent config, and
    // the default build agent applies edits without asking. Lattice does not
    // drive permission/{requestID}/reply, so nothing here is interactive.
    approvals: 'fixed-never',
    goals: false,
    // Sessions accept a parentID, but the resulting branch needs its event
    // history re-keyed before Lattice can render it — same gap as Codex.
    branching: 'unsupported',
    // POST /session/:id/model switches mid-session. Reasoning effort is not a
    // separate knob; opencode expresses it through the model's `variant`.
    modelSwitching: { model: true, reasoningEffort: false },
  },
  antigravity: {
    // agy's stream-json input takes text blocks only: an image is saved to a
    // file the model opens, and attached text goes inline.
    attachments: { image: true, text: true, pdf: false },
    interactiveQuestions: false,
    // Launched with --dangerously-skip-permissions; agy never asks.
    approvals: 'fixed-never',
    goals: false,
    branching: 'unsupported',
    // Model and thinking level combine into one id (e.g. gemini-4-neon-high)
    // and apply on the next idle turn via respawn-with-resume.
    modelSwitching: { model: true, reasoningEffort: true },
  },
  inkling: {
    // A local text model: attached text goes inline, images and PDFs are refused.
    attachments: { image: false, text: true, pdf: false },
    interactiveQuestions: false,
    // Every shell command and file change asks; the permission bridge answers
    // from the conversation's mode, its allowlists or an approval card.
    approvals: 'interactive',
    goals: false,
    branching: 'unsupported',
    // One local model, nothing to switch to.
    modelSwitching: { model: false, reasoningEffort: false },
  },
};

export function getProviderCapabilities(provider: Provider): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider];
}

export function supportsAttachments(provider: Provider): boolean {
  const attachments = getProviderCapabilities(provider).attachments;
  return attachments.image || attachments.text || attachments.pdf;
}
