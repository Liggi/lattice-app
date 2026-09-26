import React, { useState } from 'react';
import { Composer } from '../../components/Composer';

interface ComposerSendStateHarnessProps {
  /** Seed text for the composer. Empty string means an idle composer. */
  initialValue?: string;
  /** Hosts with out-of-band content (annotations, queued drafts) pass this. */
  allowEmptySubmit?: boolean;
}

/**
 * Test harness for the Send button's disabled state.
 *
 * Reports submissions in a counter so a test can tell "the button looked
 * disabled" apart from "the button actually refused the click".
 */
export function ComposerSendStateHarness({
  initialValue = '',
  allowEmptySubmit,
}: ComposerSendStateHarnessProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [submits, setSubmits] = useState(0);

  return (
    <div className="dark bg-zinc-950 p-6" style={{ width: 600 }}>
      <Composer
        core={{
          onSubmit: () => setSubmits((n) => n + 1),
          value,
          onChange: setValue,
          allowEmptySubmit,
        }}
      />
      <output data-testid="submit-count">{submits}</output>
      <button data-testid="set-text" onClick={() => setValue('hello')}>
        Set text
      </button>
      <button data-testid="clear-text" onClick={() => setValue('')}>
        Clear
      </button>
    </div>
  );
}
