/**
 * LatticeComposer — wraps the toolkit Composer with Lattice's palette and the
 * "working" sweep.
 *
 * Lattice overrides the toolkit's CSS custom properties (--color-composer-*)
 * in theme.css. lattice-composer.css adds the one piece of chrome that doesn't
 * belong in the generic toolkit component. Emoji come from the toolkit's
 * table: `:shortcode` autocomplete through its `searchEmoji`, and its emoji
 * button in the leading-actions slot.
 */

import React, { useCallback, forwardRef } from 'react';
import {
  Composer,
  type ComposerRef,
  type ComposerRuntimeConfig,
  type AttachmentBlock,
  ComposerEmojiButton,
  useEmojiShortcodeSearch,
} from '@liggi/agent-ui-toolkit';
import type { ContentBlockParam } from '../../types';
import type { Provider } from '@/types/unified-messages';
import { supportsAttachments } from '@/types/provider-capabilities';
import './lattice-composer.css';

// ── Attachment format adapter ──

function toContentBlockParam(block: AttachmentBlock): ContentBlockParam {
  if (block.type === 'image') {
    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: block.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: block.base64!,
      },
    };
  } else if (block.type === 'text') {
    return {
      type: 'text' as const,
      text: `[File: ${block.fileName}]\n${block.textContent}`,
    };
  } else {
    return {
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        media_type: 'application/pdf' as const,
        data: block.base64!,
      },
    };
  }
}

// ── Props ──

export interface LatticeComposerProps {
  core?: {
    value?: string;
    onChange?: (value: string) => void;
    /** Lattice submit signature (flat args for backward compatibility). */
    onSubmit: (
      message: string,
      workingDirectory?: string,
      model?: string,
      permissionMode?: string,
      attachments?: ContentBlockParam[],
      effort?: string,
    ) => void | Promise<void>;
    placeholder?: string;
    isLoading?: boolean;
    disabled?: boolean;
    sessionId?: string;
    /** Let an empty composer submit — used when pending annotations will fill
     *  the outgoing message on their own. */
    allowEmptySubmit?: boolean;
  };
  features?: {
    enableAttachments?: boolean;
    enableFileAutocomplete?: boolean;
    showStatusBar?: boolean;
  };
  workingDirectory?: string;
  permissionConfig?: {
    onStop?: () => void | Promise<void>;
    onInterrupt?: () => void | Promise<void>;
  };
  runtimeConfig?: ComposerRuntimeConfig;
  provider?: Provider;
  /** Trust mode persisted on the conversation or resolved for a new launch. */
  permissionMode?: string;
  className?: string;
  /**
   * Extra status-bar content, rendered by the toolkit immediately after the
   * model badge. Forwarded verbatim through the rest spread.
   */
  renderStatusExtra?: () => React.ReactNode;
  /** Compact host-app action rendered immediately before Send. */
  renderActionsExtra?: () => React.ReactNode;
}

export const LatticeComposer = forwardRef<ComposerRef, LatticeComposerProps>(
  function LatticeComposer(props, ref) {
    const {
      core,
      features,
      provider = 'claude',
      permissionMode = 'bypassPermissions',
      ...rest
    } = props;
    const composerRef = React.useRef<ComposerRef>(null);

    // Forward ref
    React.useImperativeHandle(ref, () => ({
      focusInput: () => composerRef.current?.focusInput(),
      insertText: (text: string) => composerRef.current?.insertText(text),
    }));

    // The toolkit's emoji table; until its chunk arrives `:` simply opens nothing.
    const handleSearchEmoji = useEmojiShortcodeSearch();
    const renderEmojiButton = useCallback(
      () => (
        <ComposerEmojiButton
          disabled={core?.disabled}
          onPick={(emoji) => composerRef.current?.insertText(emoji)}
        />
      ),
      [core?.disabled],
    );

    // Adapt submit: toolkit → Lattice flat signature
    const onSubmitFn = core?.onSubmit;
    const handleSubmit = useCallback(
      (message: string, options?: { workingDirectory?: string; model?: string; attachments?: AttachmentBlock[]; effort?: string }) => {
        const attachments = options?.attachments?.map(toContentBlockParam);
        return onSubmitFn?.(
          message,
          options?.workingDirectory,
          options?.model,
          permissionMode,
          attachments,
          options?.effort,
        );
      },
      [onSubmitFn, permissionMode],
    );

    return (
      <div className="lattice-composer">
        <Composer
          ref={composerRef}
          core={core ? {
            ...core,
            onSubmit: handleSubmit,
          } : undefined}
          features={{
            ...features,
            // Provider capability belongs here, not at each call site. Override
            // stale caller gates centrally as providers gain new input support.
            enableAttachments: supportsAttachments(provider),
            showMenu: false,
          }}
          searchEmoji={handleSearchEmoji}
          renderLeadingActions={renderEmojiButton}
          {...rest}
        />
      </div>
    );
  },
);
