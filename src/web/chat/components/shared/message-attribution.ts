import type { MessageAttribution } from '../../types/index.js';
import type { SenderIdentity } from './sender-names.js';

/**
 * The line above a message the user did not write. It says who sent it in the
 * same words the recipient model is given (`formatAgentMessage` in
 * services/sessions/session-inbox.ts), so the thread and the model agree.
 * A sender that declared nothing is unidentified, never the user.
 *
 * With an identity the line says the session's role and what it is working
 * on; without one it shows the id exactly as the sender declared it.
 */
export function attributionLabel(attribution: MessageAttribution, identity?: SenderIdentity | null): string {
  const who = identity
    ? (identity.role === 'coordinator' ? `the coordinator for ${identity.name}` : `the worker on ${identity.name}`)
    : attribution.sender ?? 'an unidentified sender';
  return attribution.passedOn ? `From ${who}, relaying your decision` : `From ${who}`;
}
