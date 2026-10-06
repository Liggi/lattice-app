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
  type LargeTextFileUpload,
  ComposerEmojiButton,
  useEmojiShortcodeSearch,
} from '@liggi/agent-ui-toolkit';
import type { ContentBlockParam } from '../../types';
import type { PastedSpan } from '@liggi/agent-ui-harness/protocol';
import type { Provider } from '@/types/unified-messages';
import { supportsAttachments } from '@/types/provider-capabilities';
import {
  INLINE_TEXT_FILE_MAX_BYTES,
  UPLOADED_TEXT_FILE_MAX_BYTES,
  formatAttachedTextFile,
  formatUploadedTextFile,
} from '@/constants/attached-text-file';
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
      text: formatAttachedTextFile(
        block.fileName,
        block.uploadId ? formatUploadedTextFile(block.uploadId, block.size ?? 0) : block.textContent ?? '',
      ),
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

// ── Large text files ──

/**
 * A text file too large to send inline is streamed to the server as it is
 * attached, so its bytes never sit in the page or a message body; the
 * message carries the upload id and the server saves the file for the agent
 * (large-attached-files.ts).
 */
async function uploadTextFile(file: File): Promise<string> {
  const response = await fetch('/api/attachment-uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const result = await response.json().catch(() => ({})) as { uploadId?: string; error?: string };
  if (!response.ok || !result.uploadId) throw new Error(result.error ?? `Upload failed (HTTP ${response.status})`);
  return result.uploadId;
}

const LARGE_TEXT_FILES: LargeTextFileUpload = {
  overBytes: INLINE_TEXT_FILE_MAX_BYTES,
  maxBytes: UPLOADED_TEXT_FILE_MAX_BYTES,
  upload: uploadTextFile,
};

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
      pastes?: PastedSpan[],
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
      (message: string, options?: { workingDirectory?: string; model?: string; attachments?: AttachmentBlock[]; effort?: string; pastes?: PastedSpan[] }) => {
        const attachments = options?.attachments?.map(toContentBlockParam);
        return onSubmitFn?.(
          message,
          options?.workingDirectory,
          options?.model,
          permissionMode,
          attachments,
          options?.effort,
          options?.pastes,
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
          largeTextFiles={LARGE_TEXT_FILES}
          renderLeadingActions={renderEmojiButton}
          {...rest}
        />
      </div>
    );
  },
);
