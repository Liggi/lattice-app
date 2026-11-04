/**
 * How an agent shows screenshots as a series with its own notes on them: the
 * ```lattice-gallery fence (src/web/chat/utils/gallery-block.ts reads it).
 * Boxes are the weak point, so the guidance asks for measured boxes and the
 * pixel size they were measured in; Lattice scales boxes from that size to the
 * file, so a box taken at 1× on a 2× screenshot still lands.
 */
export function galleryGuidance(readsImages = true): string[] {
  return [
    'Screenshots with notes',
    '- To show several screenshots, or to point at parts of one, write a ```lattice-gallery fence instead of separate',
    '  images. Lattice shows them as a series the reader pages through full screen, with your notes drawn on each image;',
    '  a note with no box is about the whole image. The body is JSON:',
    '  ```lattice-gallery',
    '  { "images": [ { "path": "/abs/path/step4.png", "size": [2880, 4046], "caption": "Step 4: the replay result",',
    '      "notes": [ { "text": "Still matches: the fix misses \'feels close\'", "box": [1521, 1778, 794, 162] },',
    '                 { "text": "Nothing else on the page changed" } ] } ] }',
    '  ```',
    '- `box` is [x, y, width, height] in the pixels of `size`, and `size` is the file\'s own [width, height]: read it with',
    '  `sips -g pixelWidth -g pixelHeight <file>` (macOS) or `identify <file>` and write it down. When you captured the',
    '  page, measure each box from it: Playwright\'s `locator.boundingBox()` gives CSS pixels, so multiply by the',
    '  screenshot\'s deviceScaleFactor, or give the CSS size of the page as `size` and Lattice scales the box to the file.',
    ...(readsImages
      ? ['  When you have only the image file, estimate each box from it; the crop below is then the only check, so never skip it.']
      : ['  The model this session runs on cannot read images, so take boxes only from measured element positions; with only',
         '  the image file, leave the box out and make the note about the whole image.']),
    '  Pad a box by a few pixels so its outline does not sit on the text it marks.',
    ...(readsImages
      ? ['- Before sending, crop the file to each box (`sips -c <h> <w> --cropOffset <y> <x>`) and look: if the crop does not',
         '  show what the note is about, fix the box or drop it and let the note be about the whole image.']
      : []),
    '- Captions are the reader\'s words for what the image shows. Notes are short: one point each, a sentence at most.',
    '  Keep your explanation in the message; the notes point at the evidence for it.',
  ];
}
