import { ConfigService } from '@/services/infrastructure/config-service.js';

/**
 * How an agent draws a picture in a Lattice reply: when to draw at all, what
 * makes a good frame, and the render-and-look step (`lattice frame`). A frame
 * is a still drawn like an explainer-video frame and embedded as a PNG. It
 * replaced the ```diagram fence after a side-by-side on real replies
 * (2026-10-07): the 340-wide fence filled half the desktop column, and frames
 * with a title that states the point and large type read better. The fence
 * renderer stays so older messages still draw.
 *
 * A session whose model cannot read images is never told to open the PNGs:
 * one on a custom endpoint did (2026-10-23), and every later turn failed
 * because the transcript now held an image its model rejects.
 *
 * An install can set `figureGuide` in its config to use a figure toolkit of its
 * own instead, and `figureGuideStep` to add one step of its own to that guidance.
 * Sessions that cannot read images keep the SVG route, whose checks work from
 * the source.
 */
export function frameGuidance(
  cli: string,
  readsImages = true,
  figureGuide = configured('figureGuide'),
  figureGuideStep = configured('figureGuideStep'),
): string[] {
  if (figureGuide && readsImages) return toolkitGuidance(figureGuide, figureGuideStep);
  return [
    ...whenToDraw(),
    '- A picture is a frame: one still, like a frame from an explainer video. Write it as an SVG 1920 wide and 1080 tall',
    `  (\`viewBox="0 0 1920 1080" width="1920" height="1080"\`), render it with \`${cli} frame <file.svg>\`, and embed the PNG`,
    '  it prints as `![what it shows](/path/to/frame.png)`. Readers tap it to open it full screen and zoom. Keep the',
    '  explanation in your prose; the frame carries one point.',
    '- What makes a good frame:',
    '  - One message. Know the sentence it must get across and draw only what supports it. Two points are two frames.',
    '  - A title that states the point, not the topic: "Why today\'s run can\'t see the canary\'s changes", not "Sample',
    '    sizes". Under it, one line saying how to read the picture. A takeaway line at the bottom if it helps.',
    '  - Colour means something. Pick one colour for the thing the reader must notice (the problem, the change) and',
    '    at most one more for a second meaning, use each consistently, and keep everything else white or grey. Say what',
    '    a colour means in a label next to it, never in a legend.',
    '  - Big type. Nothing under 32px: inline on a phone a frame is about 360px wide, and smaller text cannot be read.',
    '    Title about 72px, the reading line 40, labels 44 to 52, notes 34. Few words, plenty of space, things aligned.',
    '- Palette: background #0e0f13, text #ffffff, secondary text #8a909e, lines #5b6170, panels #1b1f28, attention',
    '  #FFD54F (yellow), second meaning #8fd3e8 (teal). The renderer sets every text in one serif; set no font-family.',
    '- SVG does not wrap or measure text, so you must. A line of serif text averages about half its font size per',
    '  character (44px text: about 22px a character). Work out each line\'s width, keep 30px inside a box, and break or',
    '  shorten a line that does not fit. Draw arrows as a line plus a small filled triangle at the end.',
    '  ```svg',
    '  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">',
    '    <rect width="1920" height="1080" fill="#0e0f13"/>',
    '    <text x="960" y="100" font-size="72" fill="#ffffff" text-anchor="middle">Why every batch call is slow</text>',
    '    <text x="960" y="178" font-size="40" fill="#8a909e" text-anchor="middle">Each call rebuilds the whole history</text>',
    '    <rect x="200" y="420" width="560" height="160" rx="18" fill="#1b1f28" stroke="#FFD54F" stroke-width="3"/>',
    '    <text x="234" y="486" font-size="52" fill="#ffffff">internal</text>',
    '    <text x="234" y="540" font-size="36" fill="#FFD54F">repeated on every call</text>',
    '  </svg>',
    '  ```',
    ...(readsImages ? lookStep(cli) : sourceCheckStep(cli)),
  ];
}

/**
 * When to draw, shared by both routes. Questions about structure are named as a
 * trigger because past sessions (Apr to Nov 2026) answered them with numbered
 * steps or prose, and a picture came only after the user asked for one; small
 * flat figures with one point landed, nested maps did not.
 */
function whenToDraw(): string[] {
  return [
    'Pictures',
    '- Draw a picture only when position carries meaning: parts of a system and what flows between them, what lives',
    '  inside what and which thing points at which, a chart whose shape is the point, a rough sketch of a screen, a',
    '  branching decision, a before and after.',
    '- Questions like "what are the entities?", "where does X live?", "how do these relate?", "what loads what?" or',
    '  "walk me through it" are about structure: answer them with a picture first, not numbered steps. Each figure',
    '  has at most 5 boxes and no box drawn inside another; more than that is two or three figures in a row (what',
    '  exists, one case through it, what changes), not one map. Under each figure, write only what it cannot show',
    '  (why, the exceptions, what to do); never retell it as steps.',
    '- Steps with no shape, timelines, comparisons and yes/no grids are markdown lists and tables, which the chat renders',
    '  well. Never draw ASCII art.',
  ];
}

function configured(key: 'figureGuide' | 'figureGuideStep'): string | undefined {
  try {
    return ConfigService.getInstance().getConfig()[key];
  } catch {
    return undefined;
  }
}

function toolkitGuidance(guide: string, step?: string): string[] {
  return [
    ...whenToDraw(),
    `- Before drawing, read ${guide}, and make the picture the way it says. Do not hand-write an SVG.`,
    '- Fix every problem it reports, open the image and its phone version and look as a reader would, then embed the',
    '  PNG as `![what it shows](/path/to/figure.png)`. Keep the explanation in your prose; the figure carries one point.',
    ...(step ? [`- ${step}`] : []),
  ];
}

function lookStep(cli: string): string[] {
  return [
    `- Look before you send, every time. \`${cli} frame\` prints the frame and a second image of how small it sits inline`,
    '  on a phone, plus any problems it can see in the source. Open both and look as a reader would: text running past',
    '  a box or the frame edge, labels colliding, arrows missing their box, anything cramped or busier than it needs to',
    '  be, anything unreadable on the phone image. Fix what you see, render again, and embed once it reads well.',
  ];
}

function sourceCheckStep(cli: string): string[] {
  return [
    '- Check before you send, every time, from the SVG source. The model this session runs on cannot read images, so',
    `  never open the PNGs \`${cli} frame\` prints, with Read or any other tool: once an image is in the conversation,`,
    `  every later turn fails. \`${cli} frame\` also lists the problems it can find in the source (the wrong size, text`,
    '  too small for a phone); fix each one. Then check the source yourself: work out where each line of text ends from',
    '  its x, its anchor and its font size, and make sure it stays 30px inside its box and inside the 1920x1080 frame;',
    '  that no two labels overlap; and that each arrow ends at the edge of the box it points to. Fix what is off,',
    '  render again, and embed the PNG by its path once both checks pass.',
  ];
}
