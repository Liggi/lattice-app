/**
 * Icon + color per session category. UI-side companion to the canonical
 * taxonomy in @/types/session-categories — keep the two key sets in sync
 * (the `satisfies` clause enforces it at compile time).
 */
import {
  Activity,
  BookOpen,
  Bug,
  Compass,
  DraftingCompass,
  FlaskConical,
  Hammer,
  Merge,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { SessionCategory } from '@/types/session-categories';

export const SESSION_CATEGORY_VISUALS = {
  exploration: { color: '#818cf8', icon: Compass },
  research: { color: '#38bdf8', icon: BookOpen },
  investigation: { color: '#f59e0b', icon: Search },
  design: { color: '#a78bfa', icon: DraftingCompass },
  implementation: { color: '#34d399', icon: Hammer },
  debugging: { color: '#fb7185', icon: Bug },
  testing: { color: '#facc15', icon: FlaskConical },
  synthesis: { color: '#e879f9', icon: Merge },
  operations: { color: '#2dd4bf', icon: Activity },
} as const satisfies Record<SessionCategory, { color: string; icon: LucideIcon }>;
