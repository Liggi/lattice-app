import { geminiService, type GeminiService } from '@/services/gemini-service.js';

const CHARACTER_NAMES = [
  'Mara', 'Oren', 'Venn', 'Tess', 'Nilo', 'Ivo', 'Sable', 'Kest',
  'Rumi', 'Ansel', 'Orla', 'Miro', 'Nia', 'Bram', 'Elio', 'Tavi',
  'Juno', 'Fenn', 'Luma', 'Rook', 'Pip', 'Vale', 'Moss', 'Kira',
  'Otis', 'Zuri', 'Cato', 'Wren', 'Della', 'Remy', 'Ilya', 'Sora',
  'Toma', 'Neve', 'Arlo', 'Mina', 'Bo', 'Cleo', 'Niko', 'Edda',
  'Rune', 'Zeno', 'Lumi', 'Puck', 'Aya', 'Kumo', 'Yara', 'Vero',
] as const;

const NAME_STRIDE = 17;

export interface PinnedCharacterContext {
  mission?: string | null;
  currentAim?: string | null;
  initialPrompt?: string | null;
  project?: string | null;
  workingDirectory?: string | null;
  theme?: string | null;
}

export interface PinnedCharacter {
  name: string;
  imageData: string;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function choosePinnedCharacterName(
  sessionId: string,
  existingNames: Iterable<string>,
): string {
  const used = new Set(Array.from(existingNames, name => name.trim().toLowerCase()).filter(Boolean));
  const start = hashString(sessionId) % CHARACTER_NAMES.length;

  for (let offset = 0; offset < CHARACTER_NAMES.length; offset += 1) {
    const candidate = CHARACTER_NAMES[(start + offset * NAME_STRIDE) % CHARACTER_NAMES.length];
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  const base = CHARACTER_NAMES[start];
  let suffix = 2;
  while (used.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

function cleanContext(value: string | null | undefined, maxLength = 600): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function buildPinnedCharacterPrompt(
  name: string,
  context: PinnedCharacterContext,
): string {
  const contextLines = [
    ['Original mission', context.mission],
    ['Current direction', context.currentAim],
    ['First request', context.initialPrompt],
    ['Project', context.project],
    ['Working directory', context.workingDirectory],
    ['Work mode', context.theme],
  ]
    .map(([label, value]) => {
      const cleaned = cleanContext(value);
      return cleaned ? `${label}: ${cleaned}` : null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');

  return `Create a square pixel-art portrait for a persistent named character called ${name}.

This is a quiet recurring character with a human social presence, not a creature or topic mascot. Make them human or unmistakably person-like: no animal, monster, robot, construct, spirit, helmeted figure, chibi companion, or generic fantasy archetype. Give them a specific face, natural proportions, a restrained expression, and one or two memorable visual traits.

Use the work context only as quiet thematic influence: borrow a mood, material, colour, or tiny prop when it feels natural. Do not literally depict software, laptops, code, product logos, or a visual summary of the task. The character should remain recognizable even when the work changes.

Composition requirements:
- one close head-and-shoulders portrait, facing toward the viewer
- let the face and shoulders fill most of the square so the character reads clearly at 32px
- simple near-black background with strong face/background separation
- restrained, precise pixel art with a deliberate limited palette
- no decorative frame, border, card, medallion, vignette, or ornamental corners
- no text, letters, nameplate, UI, or watermark

${contextLines || 'There is no reliable work context yet; invent a distinctive, understated person without making them topical.'}`;
}

export class PinnedCharacterService {
  private readonly inflight = new Map<string, Promise<PinnedCharacter>>();

  constructor(private readonly imageService: GeminiService = geminiService) {}

  isAvailable(): boolean {
    return this.imageService.isConsultationAvailable();
  }

  async generate(
    sessionId: string,
    context: PinnedCharacterContext,
    existingNames: Iterable<string>,
  ): Promise<PinnedCharacter> {
    const existing = this.inflight.get(sessionId);
    if (existing) return existing;

    const name = choosePinnedCharacterName(sessionId, existingNames);
    const request = this.imageService
      .generatePinnedCharacterImage(buildPinnedCharacterPrompt(name, context))
      .then(({ imageData }) => ({ name, imageData }))
      .finally(() => this.inflight.delete(sessionId));

    this.inflight.set(sessionId, request);
    return request;
  }
}

export const pinnedCharacterService = new PinnedCharacterService();
