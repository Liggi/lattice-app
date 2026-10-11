import React, { useState } from 'react';
import { Composer } from '../../components/Composer';

/**
 * Test harness for the markdown text box. Records each send's text and long
 * pastes exactly, so a test can check the text box changed nothing it sent.
 */
export function ComposerMarkdownHarness(): React.JSX.Element {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<Array<{ text: string; pastes?: unknown }>>([]);

  return (
    <div className="dark bg-zinc-950 p-6" style={{ width: 600 }}>
      <Composer
        core={{
          onSubmit: (text, options) => setSent((all) => [...all, { text, pastes: options?.pastes }]),
          value,
          onChange: setValue,
        }}
      />
      <output data-testid="sent">{JSON.stringify(sent)}</output>
    </div>
  );
}
