import { useState, useCallback } from 'react';
import type { LargeTextFileUpload } from '../components/Composer/types.js';

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
/** Largest image sent as-is: its base64 stays under the 5MB the model APIs accept. */
const MAX_IMAGE_PASSTHROUGH_BYTES = 3.75 * 1024 * 1024;
/** Long edge for re-encoded images; Claude scales anything larger down to ~1568px. */
const MAX_IMAGE_EDGE_PX = 2048;
const IMAGE_EXTENSIONS = /\.(heic|heif|jpe?g|png|gif|webp|avif|bmp|tiff?)$/i;
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
  /** A large text file the host already received (see LargeTextFileUpload). */
  uploadId?: string;
  /** Size of the original file in bytes. */
  size?: number;
}

export interface Attachment {
  id: string;
  file: File;
  name: string;
  type: 'image' | 'document' | 'text';
  mimeType: string;
  base64: string | null;
  textContent: string | null;
  uploadId?: string;
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

function getAttachmentType(file: File): 'image' | 'document' | 'text' | null {
  const mimeType = file.type;
  // Phones hand over HEIC, or no type at all; those are decoded and re-encoded.
  if (mimeType.startsWith('image/') || (!mimeType && IMAGE_EXTENSIONS.test(file.name))) {
    return 'image';
  }
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

function decodeImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  return img
    .decode()
    .then(() => img)
    .finally(() => URL.revokeObjectURL(url));
}

/**
 * Images the model APIs take as they are pass through untouched. Anything else
 * (HEIC, a camera-sized JPEG) is redrawn at most MAX_IMAGE_EDGE_PX on its long
 * edge and sent as JPEG.
 */
async function prepareImage(file: File): Promise<{ base64: string; mimeType: string }> {
  if (IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_PASSTHROUGH_BYTES) {
    return { base64: await fileToBase64(file), mimeType: file.type };
  }
  let img: HTMLImageElement;
  try {
    img = await decodeImage(file);
  } catch {
    throw new Error(`This browser can't read ${file.type || 'this image format'}; send a JPEG or PNG`);
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not resize the image');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
  if (!base64) throw new Error('Could not resize the image');
  if (base64.length > MAX_FILE_SIZE) throw new Error('Image is still over 5MB after resizing');
  return { base64, mimeType: 'image/jpeg' };
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

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

export function useAttachments(largeTextFiles?: LargeTextFileUpload): UseAttachmentsReturn {
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
        const type = getAttachmentType(file);
        if (!type) {
          errors.push(`${file.name}: Unsupported file type (${file.type || 'unknown'})`);
          continue;
        }
        const maxSize = type === 'text' && largeTextFiles ? largeTextFiles.maxBytes : MAX_FILE_SIZE;
        if (type !== 'image' && file.size > maxSize) {
          errors.push(`${file.name}: File too large (${megabytes(file.size)}, max ${megabytes(maxSize)})`);
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

        const uploadLarge = attachment.type === 'text' && largeTextFiles && attachment.size > largeTextFiles.overBytes
          ? largeTextFiles
          : null;
        const processFile: Promise<{ base64: string | null; textContent: string | null; mimeType: string; uploadId?: string }> =
          uploadLarge
            ? uploadLarge.upload(attachment.file).then((uploadId) => ({
                uploadId,
                textContent: null,
                base64: null,
                mimeType: attachment.mimeType,
              }))
          : attachment.type === 'text'
            ? fileToText(attachment.file).then((textContent) => ({
                textContent,
                base64: null,
                mimeType: attachment.mimeType,
              }))
            : attachment.type === 'image'
              ? prepareImage(attachment.file).then((image) => ({ ...image, textContent: null }))
              : fileToBase64(attachment.file).then((base64) => ({
                  base64,
                  textContent: null,
                  mimeType: attachment.mimeType,
                }));

        processFile
          .then(({ base64, textContent, mimeType, uploadId }) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === attachment.id
                  ? { ...a, base64, textContent, mimeType, uploadId, status: 'ready' as const }
                  : a,
              ),
            );
          })
          .catch((err: unknown) => {
            // A file that can't be used leaves the strip and says why, rather
            // than sitting there to be dropped from the message on send.
            const errorMessage = err instanceof Error ? err.message : 'Upload failed';
            setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
            setError((prev) => [prev, `${attachment.name}: ${errorMessage}`].filter(Boolean).join('; '));
          });
      }
    },
    [attachments.length, largeTextFiles],
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
      .filter((a) => a.status === 'ready' && (a.base64 || a.textContent || a.uploadId))
      .map((att) => ({
        type: att.type,
        mimeType: att.mimeType,
        base64: att.base64 ?? undefined,
        textContent: att.textContent ?? undefined,
        fileName: att.name,
        size: att.size,
        ...(att.uploadId ? { uploadId: att.uploadId } : {}),
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
