import React, { useRef, useState } from 'react';
import { Composer } from '../../components/Composer';
import type { ComposerRef, EmojiSuggestion } from '../../components/Composer/types';

const TABLE: EmojiSuggestion[] = [
  { emoji: '👍', shortcode: 'thumbsup' },
  { emoji: '👎', shortcode: 'thumbsdown' },
  { emoji: '🎉', shortcode: 'tada' },
];

/**
 * Test harness for `:shortcode` autocomplete. Records what was submitted, so
 * a test can tell "Enter picked an emoji" apart from "Enter sent the message".
 */
export function ComposerEmojiHarness(): React.JSX.Element {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const composer = useRef<ComposerRef>(null);

  return (
    <div className="dark bg-zinc-950 p-6" style={{ width: 600, paddingTop: 200 }}>
      <Composer
        ref={composer}
        core={{ onSubmit: (message) => setSent((all) => [...all, message]), value, onChange: setValue }}
        searchEmoji={(query) => TABLE.filter((entry) => entry.shortcode.startsWith(query.toLowerCase()))}
      />
      <output data-testid="sent">{JSON.stringify(sent)}</output>
      <button data-testid="insert-rocket" onClick={() => composer.current?.insertText('🚀')}>
        Insert
      </button>
    </div>
  );
}
