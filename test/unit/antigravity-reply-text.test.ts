/**
 * Gemini sometimes ends an Antigravity reply and goes on to write the next turn
 * itself; Lattice cuts the reply where that invented turn starts.
 */

import { describe, expect, it } from 'vitest';
import { agyReplyText } from '../../src/harness/antigravity-process-adapter.js';

// A model step recorded from a real agy session on 2026-11-22, with its task text replaced.
const INVENTED_TURN = `NO_REPLY
user
The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-11-22T16:21:27Z sender=00000000-0000-4000-8000-000000000000/task-83 priority=MESSAGE_PRIORITY_HIGH content=Check the production deploy status for commit 0123456789abcdef0123456789abcdef01234567. Once completed, update the notes, close the thread, and report back.
</SYSTEM_MESSAGE>`;

describe('agyReplyText', () => {
  it('cuts a reply at an invented user turn', () => {
    expect(agyReplyText(INVENTED_TURN)).toBe('NO_REPLY');
    expect(agyReplyText(`Deploy is live.\n\n${INVENTED_TURN.slice('NO_REPLY\n'.length)}model\nNO_REPLY`))
      .toBe('Deploy is live.');
  });

  it('keeps replies that only mention the user or a system message', () => {
    const replies = [
      'The user asked for a deploy check.\nuser\nis the role name agy prints.',
      'agy wakes me with a message like:\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=… content=…\n</SYSTEM_MESSAGE>',
      'Set the owner to\nuser\n\nand retry.',
    ];
    for (const reply of replies) expect(agyReplyText(reply)).toBe(reply);
  });
});
