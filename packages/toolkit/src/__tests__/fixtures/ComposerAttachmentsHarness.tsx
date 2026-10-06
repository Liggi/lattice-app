import React, { useState } from 'react';
import { Composer } from '../../components/Composer';
import type { AttachmentBlock } from '../../hooks/useAttachments';

/**
 * Test harness for attaching files. Each submission is written out as
 * "mimeType:base64Length" per attachment so a test can see what was sent.
 */
export function ComposerAttachmentsHarness(): React.JSX.Element {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<string[] | null>(null);

  return (
    <div className="dark bg-zinc-950 p-3" style={{ width: 360 }}>
      <Composer
        core={{
          value,
          onChange: setValue,
          onSubmit: (_message, options) =>
            setSent(
              (options?.attachments ?? []).map(
                (a: AttachmentBlock) => `${a.mimeType}:${a.base64?.length ?? 0}`,
              ),
            ),
        }}
      />
      <output data-testid="sent">{sent === null ? '' : JSON.stringify(sent)}</output>
    </div>
  );
}
