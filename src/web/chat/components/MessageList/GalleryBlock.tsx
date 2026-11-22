import React, { type JSX } from 'react';
import { parseGalleryBlock } from '../../utils/gallery-block';
import { ViewableImage } from './ImageViewer';

/**
 * A ```lattice-gallery fence: the agent's screenshots as a series, each with
 * its caption, opening in the viewer with the agent's notes drawn on them.
 * A block that cannot be read says why, above its source.
 */
export function GalleryBlock({ source, imageUrl }: { source: string; imageUrl: (path: string) => string | undefined }): JSX.Element {
  const parsed = parseGalleryBlock(source);
  if (!parsed.ok) {
    return (
      <div className="not-prose my-3 rounded-md border border-line" data-gallery-error>
        <div className="border-b border-line px-3 py-2 text-xs text-danger">Couldn't show this gallery: {parsed.error}</div>
        <pre className="m-0 overflow-x-auto px-3 py-2 text-xs text-fg-2">{source}</pre>
      </div>
    );
  }
  return (
    <div className="not-prose my-3 flex flex-col gap-4" data-gallery-block>
      {parsed.images.map((image, i) => {
        const url = imageUrl(image.path);
        const count = image.notes.length;
        return (
          <figure key={`${i}-${image.path}`} className="m-0 flex flex-col gap-1.5">
            <ViewableImage src={url} alt={image.caption} notes={image.notes} size={image.size} className="inline-block max-w-full cursor-zoom-in">
              <img
                src={url}
                alt={image.caption}
                loading="lazy"
                className="block max-w-full h-auto max-h-[70vh] rounded-md border border-line"
              />
            </ViewableImage>
            {(image.caption || count > 0) && (
              <figcaption className="text-[13px] leading-snug text-fg-2">
                {image.caption}
                {count > 0 && <span className="text-fg-3">{image.caption ? ' · ' : ''}{count === 1 ? '1 note' : `${count} notes`}</span>}
              </figcaption>
            )}
          </figure>
        );
      })}
    </div>
  );
}
