import { useState, useCallback } from 'react';

// ── Supported file types ──

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const DOCUMENT_TYPES = ['application/pdf'];
const TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_ATTACHMENTS = 20;

// ── Public types ──

/** A processed attachment ready for submission. */
export interface AttachmentBlock {
  type: 'image' | 'document' | 'text';
  /** MIME type of the original file. */
  mimeType: string;
  /** Base64-encoded content (images and PDFs). */
  base64?: string;
  /** Plain-text content (text files). */
  textContent?: string;
  /** Original filename — useful for text-file context. */
  fileName: string;
}

export interface Attachment {
  id: string;
  file: File;
  name: string;
  type: 'image' | 'document' | 'text';
  mimeType: string;
  base64: string | null;
  textContent: string | null;
  status: 'pending' | 'processing' | 'ready' | 'error';
  error?: string;
  size: number;
}

export interface UseAttachmentsReturn {
  attachments: Attachment[];
  addFiles: (files: FileList | File[]) => void;
  removeAttachment: (id: string) => void;
  clearAll: () => void;
  /** Returns structured blocks suitable for LLM submission. */
  getContentBlocks: () => AttachmentBlock[];
  isProcessing: boolean;
  hasAttachments: boolean;
  totalSize: number;
  error: string | null;
}

// ── Helpers ──

function generateId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getAttachmentType(mimeType: string): 'image' | 'document' | 'text' | null {
  if (IMAGE_TYPES.includes(mimeType)) return 'image';
  if (DOCUMENT_TYPES.includes(mimeType)) return 'document';
  if (TEXT_TYPES.includes(mimeType)) return 'text';
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// ── Hook ──

export function useAttachments(): UseAttachmentsReturn {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      setError(null);

      if (attachments.length + fileArray.length > MAX_ATTACHMENTS) {
        setError(`Maximum ${MAX_ATTACHMENTS} attachments allowed`);
        return;
      }

      const newAttachments: Attachment[] = [];
      const errors: string[] = [];

      for (const file of fileArray) {
        const type = getAttachmentType(file.type);
        if (!type) {
          errors.push(`${file.name}: Unsupported file type (${file.type || 'unknown'})`);
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
          errors.push(`${file.name}: File too large (${sizeMB}MB, max 5MB)`);
          continue;
        }

        newAttachments.push({
          id: generateId(),
          file,
          name: file.name,
          type,
          mimeType: file.type,
          base64: null,
          textContent: null,
          status: 'pending',
          size: file.size,
        });
      }

      if (errors.length > 0) setError(errors.join('; '));
      if (newAttachments.length === 0) return;

      setAttachments((prev) => [...prev, ...newAttachments]);

      for (const attachment of newAttachments) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === attachment.id ? { ...a, status: 'processing' as const } : a)),
        );

        const processFile =
          attachment.type === 'text'
            ? fileToText(attachment.file).then((textContent) => ({ textContent, base64: null }))
            : fileToBase64(attachment.file).then((base64) => ({ base64, textContent: null }));

        processFile
          .then(({ base64, textContent }) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === attachment.id ? { ...a, base64, textContent, status: 'ready' as const } : a,
              ),
            );
          })
          .catch((err: unknown) => {
            const errorMessage = err instanceof Error ? err.message : 'Upload failed';
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === attachment.id ? { ...a, status: 'error' as const, error: errorMessage } : a,
              ),
            );
          });
      }
    },
    [attachments.length],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setError(null);
  }, []);

  const clearAll = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, []);

  const getContentBlocks = useCallback((): AttachmentBlock[] => {
    return attachments
      .filter((a) => a.status === 'ready' && (a.base64 || a.textContent))
      .map((att) => ({
        type: att.type,
        mimeType: att.mimeType,
        base64: att.base64 ?? undefined,
        textContent: att.textContent ?? undefined,
        fileName: att.name,
      }));
  }, [attachments]);

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAll,
    getContentBlocks,
    isProcessing: attachments.some((a) => a.status === 'pending' || a.status === 'processing'),
    hasAttachments: attachments.length > 0,
    totalSize: attachments.reduce((sum, a) => sum + a.size, 0),
    error,
  };
}
