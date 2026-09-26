import React, { useState } from 'react';
import { Composer } from '../../components/Composer';

interface ComposerHeightHarnessProps {
  /** Number of newline-separated lines to seed the textarea with. */
  lines?: number;
}

/**
 * Test harness for the Composer textarea auto-grow cap.
 *
 * Renders a controlled Composer seeded with `lines` lines of text, plus a
 * button that swaps the value back to a single short line so a test can
 * observe grow -> cap -> shrink.
 */
export function ComposerHeightHarness({
  lines = 12,
}: ComposerHeightHarnessProps): React.JSX.Element {
  const manyLines = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
  const [value, setValue] = useState(manyLines);

  return (
    <div className="dark bg-zinc-950 p-6" style={{ width: 600 }}>
      <Composer
        core={{
          onSubmit: () => {},
          value,
          onChange: setValue,
        }}
      />
      <button data-testid="set-single-line" onClick={() => setValue('one line')}>
        Single line
      </button>
      <button data-testid="set-many-lines" onClick={() => setValue(manyLines)}>
        Many lines
      </button>
    </div>
  );
}
