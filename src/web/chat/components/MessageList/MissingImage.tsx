import type { JSX } from 'react';

/** Stands in for an image whose file has gone, instead of the browser's broken-image icon. */
export function MissingImage({ alt }: { alt?: string }): JSX.Element {
  return (
    <span
      data-missing-image
      title={alt || undefined}
      className="not-prose my-1 inline-block self-start rounded-md border border-line px-3 py-2 text-[12px] leading-snug text-fg-3"
    >
      Image no longer on disk
    </span>
  );
}
