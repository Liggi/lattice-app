import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../utils/cn.js';

export interface MatrixModelItem {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  other?: boolean;
  efforts?: string[];
  defaultEffort?: string;
}

export interface MatrixEffortItem {
  id: string;
  label: string;
  shortLabel?: string;
  description?: string;
  isDefault?: boolean;
}

type RGB = [number, number, number];

interface EffortPalette {
  core: RGB;
  highlight: RGB;
  deep: RGB;
}

// Semantic effort palette — locked to effort meaning (not column index) across all providers.
const EFFORT_PALETTES: Record<string, EffortPalette> = {
  default: {
    core: [232, 230, 227],
    highlight: [255, 255, 255],
    deep: [158, 154, 148],
  },
  low: {
    core: [106, 168, 252],
    highlight: [219, 238, 255],
    deep: [44, 102, 214],
  },
  medium: {
    core: [72, 214, 196],
    highlight: [208, 252, 245],
    deep: [22, 138, 126],
  },
  high: {
    core: [251, 200, 78],
    highlight: [255, 245, 204],
    deep: [198, 124, 22],
  },
  xhigh: {
    core: [251, 148, 66],
    highlight: [255, 232, 204],
    deep: [204, 82, 20],
  },
  max: {
    core: [248, 114, 42],
    highlight: [255, 218, 184],
    deep: [184, 58, 14],
  },
  ultra: {
    core: [248, 106, 134],
    highlight: [255, 220, 228],
    deep: [178, 30, 68],
  },
};

const FALLBACK_PALETTES: EffortPalette[] = [
  EFFORT_PALETTES.default,
  EFFORT_PALETTES.low,
  EFFORT_PALETTES.medium,
  EFFORT_PALETTES.high,
  EFFORT_PALETTES.xhigh,
  EFFORT_PALETTES.max,
  EFFORT_PALETTES.ultra,
];

function paletteForEffort(effortId: string, colIndex: number, colCount: number): EffortPalette {
  const known = EFFORT_PALETTES[effortId];
  if (known) return known;
  if (colCount <= 1) return FALLBACK_PALETTES[0];
  const idx = Math.round((colIndex / (colCount - 1)) * (FALLBACK_PALETTES.length - 1));
  return FALLBACK_PALETTES[idx] ?? EFFORT_PALETTES.default;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function rgbStr(c: RGB): string {
  return `${c[0]}, ${c[1]}, ${c[2]}`;
}

function rgbaStr(c: RGB, alpha: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha.toFixed(3)})`;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function orbBackground(palette: EffortPalette): string {
  return `radial-gradient(circle at 36% 28%, ${rgbaStr(palette.highlight, 0.98)} 0%, ${rgbaStr(palette.core, 0.98)} 46%, ${rgbaStr(palette.deep, 1)} 100%)`;
}

const MOBILE_EFFORT_LABELS: Record<string, string> = {
  default: 'Default',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'X-high',
  max: 'Max',
  ultra: 'Ultra',
};

export const MATRIX_ROW_HEIGHT = 37;
export const MATRIX_PAD_Y = 12;

export function estimateMatrixHeight(visibleModelCount: number, hasOtherModels: boolean, hasNote: boolean): number {
  // Tabs (46) + Header (56) + pad vertical padding (24) + rows*37 + x-axis (28) + optional footer (34) + optional note (24)
  return 46 + 56 + MATRIX_PAD_Y * 2 + visibleModelCount * MATRIX_ROW_HEIGHT + 28 + (hasOtherModels ? 34 : 0) + (hasNote ? 24 : 0);
}

interface CellCoord {
  row: number;
  col: number;
}

interface FloatCoord {
  x: number;
  y: number;
}

export interface ModelEffortPadProps {
  groupLabel?: string;
  commonModels: MatrixModelItem[];
  otherModels: MatrixModelItem[];
  showOtherModels: boolean;
  onToggleOtherModels: () => void;
  efforts: MatrixEffortItem[];
  /** Currently committed model id (if it belongs to this group). */
  committedModelId: string | null;
  /** Currently committed effort id (if this group is active). */
  committedEffortId: string | null;
  /** True when the session/draft's active model belongs to this provider group. */
  isActiveGroup: boolean;
  note?: string;
  onCommit: (model: MatrixModelItem, effort: MatrixEffortItem) => void;
  onClose: () => void;
}

export function ModelEffortPad({
  groupLabel,
  commonModels,
  otherModels,
  showOtherModels,
  onToggleOtherModels,
  efforts,
  committedModelId,
  committedEffortId,
  isActiveGroup,
  note,
  onCommit,
  onClose,
}: ModelEffortPadProps) {
  const models = useMemo(
    () => (showOtherModels ? [...commonModels, ...otherModels] : commonModels),
    [commonModels, otherModels, showOtherModels],
  );

  const effortPalettes = useMemo(
    () => efforts.map((eff, idx) => paletteForEffort(eff.id, idx, efforts.length)),
    [efforts],
  );

  const hasLeadingDefaultCol = efforts.length > 1 && efforts[0]?.id === 'default';

  // Per-row supported column indices.
  const rowValidCols = useMemo(() => {
    return models.map((model) => {
      if (!model.efforts || model.efforts.length === 0) {
        return efforts.map((_, idx) => idx);
      }
      const allowed = new Set(model.efforts);
      const cols: number[] = [];
      efforts.forEach((eff, idx) => {
        if (allowed.has(eff.id)) cols.push(idx);
      });
      return cols.length > 0 ? cols : [0];
    });
  }, [models, efforts]);

  const nearestValidCol = useCallback(
    (row: number, targetCol: number): number => {
      const valid = rowValidCols[row];
      if (!valid || valid.length === 0) return 0;
      let best = valid[0];
      let bestDist = Math.abs(best - targetCol);
      for (let i = 1; i < valid.length; i++) {
        const dist = Math.abs(valid[i] - targetCol);
        if (dist < bestDist) {
          best = valid[i];
          bestDist = dist;
        }
      }
      return best;
    },
    [rowValidCols],
  );

  const defaultEffortColForRow = useCallback(
    (row: number): number => {
      const model = models[row];
      const valid = rowValidCols[row] ?? [0];
      if (model?.defaultEffort) {
        const idx = efforts.findIndex((e) => e.id === model.defaultEffort);
        if (idx >= 0 && valid.includes(idx)) return idx;
      }
      const groupDefaultIdx = efforts.findIndex((e) => e.isDefault);
      if (groupDefaultIdx >= 0 && valid.includes(groupDefaultIdx)) return groupDefaultIdx;
      return valid[0] ?? 0;
    },
    [models, efforts, rowValidCols],
  );

  // Committed cell exists ONLY when this provider group owns the active model.
  const committedCell = useMemo<CellCoord | null>(() => {
    if (!isActiveGroup || !committedModelId) return null;
    const row = models.findIndex((m) => m.id === committedModelId);
    if (row < 0) return null;
    const valid = rowValidCols[row] ?? [0];
    if (committedEffortId) {
      const col = efforts.findIndex((e) => e.id === committedEffortId);
      if (col >= 0 && valid.includes(col)) return { row, col };
    }
    return { row, col: defaultEffortColForRow(row) };
  }, [isActiveGroup, committedModelId, committedEffortId, models, efforts, rowValidCols, defaultEffortColForRow]);

  const initialCell = useMemo<CellCoord>(() => {
    if (committedCell) return committedCell;
    const defaultRow = Math.max(0, models.findIndex((m) => m.isDefault));
    return { row: defaultRow, col: defaultEffortColForRow(defaultRow) };
  }, [committedCell, models, defaultEffortColForRow]);

  const [activeCell, setActiveCell] = useState<CellCoord>(initialCell);
  const [hoverCell, setHoverCell] = useState<CellCoord | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);

  // Continuous puck position in grid coordinate space (x = col float, y = row float).
  const [puckPos, setPuckPos] = useState<FloatCoord>({ x: initialCell.col, y: initialCell.row });
  const puckRef = useRef<FloatCoord>({ x: initialCell.col, y: initialCell.row });
  const velRef = useRef<FloatCoord>({ x: 0, y: 0 });
  const targetRef = useRef<FloatCoord>({ x: initialCell.col, y: initialCell.row });
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  const desiredColRef = useRef<number>(initialCell.col);
  const activeCellRef = useRef<CellCoord>(initialCell);
  const padInnerRef = useRef<HTMLDivElement>(null);
  const padSurfaceRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const stopSpring = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startSpring = useCallback(() => {
    if (rafRef.current !== null) return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      const t = targetRef.current;
      puckRef.current = { x: t.x, y: t.y };
      velRef.current = { x: 0, y: 0 };
      setPuckPos({ x: t.x, y: t.y });
      return;
    }

    lastFrameRef.current = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.004, (now - lastFrameRef.current) / 1000));
      lastFrameRef.current = now;

      const cur = puckRef.current;
      const vel = velRef.current;
      const tgt = targetRef.current;

      // Crisp tracking while dragging; tactile slightly-underdamped spring on settle/keyboard.
      const stiffness = isDraggingRef.current ? 680 : 380;
      const damping = isDraggingRef.current ? 46 : 27;

      const ax = (tgt.x - cur.x) * stiffness - vel.x * damping;
      const ay = (tgt.y - cur.y) * stiffness - vel.y * damping;

      vel.x += ax * dt;
      vel.y += ay * dt;
      cur.x += vel.x * dt;
      cur.y += vel.y * dt;

      const settled =
        Math.abs(tgt.x - cur.x) < 0.002 &&
        Math.abs(tgt.y - cur.y) < 0.002 &&
        Math.abs(vel.x) < 0.005 &&
        Math.abs(vel.y) < 0.005;

      if (settled) {
        cur.x = tgt.x;
        cur.y = tgt.y;
        vel.x = 0;
        vel.y = 0;
        setPuckPos({ x: cur.x, y: cur.y });
        rafRef.current = null;
        return;
      }

      setPuckPos({ x: cur.x, y: cur.y });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => stopSpring(), [stopSpring]);

  // Reset cleanly on provider switch or committed value change.
  useEffect(() => {
    stopSpring();
    setActiveCell(initialCell);
    activeCellRef.current = initialCell;
    desiredColRef.current = initialCell.col;
    puckRef.current = { x: initialCell.col, y: initialCell.row };
    velRef.current = { x: 0, y: 0 };
    targetRef.current = { x: initialCell.col, y: initialCell.row };
    setPuckPos({ x: initialCell.col, y: initialCell.row });
    setHoverCell(null);
    setIsDragging(false);
    isDraggingRef.current = false;
    setHasInteracted(false);
  }, [groupLabel, initialCell.row, initialCell.col, stopSpring]);

  useEffect(() => {
    padSurfaceRef.current?.focus({ preventScroll: true });
  }, [groupLabel]);

  /**
   * Maps pointer coordinates to:
   * - `cell`: nearest valid (row, col)
   * - `continuous`: fluid 2D coordinate with gentle magnetic pull toward valid dots
   *   and smooth rubber-band clamping along ragged rows.
   */
  const pointerToPad = useCallback(
    (clientX: number, clientY: number): { cell: CellCoord; continuous: FloatCoord } | null => {
      const inner = padInnerRef.current;
      if (!inner || models.length === 0 || efforts.length === 0) return null;
      const rect = inner.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const rawY = Math.max(0, Math.min(models.length - 1, (clientY - rect.top) / MATRIX_ROW_HEIGHT - 0.5));
      const rawX = Math.max(0, Math.min(efforts.length - 1, ((clientX - rect.left) / rect.width) * efforts.length - 0.5));

      const row = Math.max(0, Math.min(models.length - 1, Math.round(rawY)));
      const col = nearestValidCol(row, rawX);

      const valid = rowValidCols[row] ?? [0];
      const minValidX = valid[0] ?? 0;
      const maxValidX = valid[valid.length - 1] ?? 0;

      let clampedX = rawX;
      if (rawX > maxValidX) {
        clampedX = maxValidX + Math.tanh((rawX - maxValidX) * 1.4) * 0.22;
      } else if (rawX < minValidX) {
        clampedX = minValidX - Math.tanh((minValidX - rawX) * 1.4) * 0.22;
      }

      const dx = col - clampedX;
      const dy = row - rawY;
      const dist = Math.hypot(dx, dy);
      const magnet = dist < 0.36 ? (1 - dist / 0.36) * 0.28 : 0;

      return {
        cell: { row, col },
        continuous: {
          x: clampedX + dx * magnet,
          y: rawY + dy * magnet,
        },
      };
    },
    [models.length, efforts.length, nearestValidCol, rowValidCols],
  );

  const commitCell = useCallback(
    (cell: CellCoord) => {
      const model = models[cell.row];
      const effort = efforts[cell.col];
      if (!model || !effort) return;
      onCommit(model, effort);
    },
    [models, efforts, onCommit],
  );

  const moveSpringToCell = useCallback(
    (cell: CellCoord) => {
      targetRef.current = { x: cell.col, y: cell.row };
      startSpring();
    },
    [startSpring],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    padSurfaceRef.current?.focus({ preventScroll: true });
    const hit = pointerToPad(e.clientX, e.clientY);
    if (!hit) return;
    setIsDragging(true);
    isDraggingRef.current = true;
    setHasInteracted(true);
    setHoverCell(null);
    setActiveCell(hit.cell);
    activeCellRef.current = hit.cell;
    desiredColRef.current = hit.cell.col;
    targetRef.current = hit.continuous;
    startSpring();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const hit = pointerToPad(e.clientX, e.clientY);
    if (!hit) return;
    if (isDraggingRef.current) {
      setActiveCell(hit.cell);
      activeCellRef.current = hit.cell;
      desiredColRef.current = hit.cell.col;
      targetRef.current = hit.continuous;
      startSpring();
    } else if (e.pointerType === 'mouse') {
      const inner = padInnerRef.current;
      if (!inner) return;
      const rect = inner.getBoundingClientRect();
      const rawX = ((e.clientX - rect.left) / rect.width) * efforts.length - 0.5;
      const valid = rowValidCols[hit.cell.row] ?? [0];
      const maxValid = valid[valid.length - 1] ?? 0;
      if (rawX <= maxValid + 0.55 && Math.abs(rawX - hit.cell.col) <= 0.6) {
        setHoverCell(hit.cell);
      } else {
        setHoverCell(null);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const hit = pointerToPad(e.clientX, e.clientY);
    const finalCell = hit ? hit.cell : activeCellRef.current;
    setIsDragging(false);
    isDraggingRef.current = false;
    setActiveCell(finalCell);
    activeCellRef.current = finalCell;
    moveSpringToCell(finalCell);
    commitCell(finalCell);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
    isDraggingRef.current = false;
    setHasInteracted(false);
    setActiveCell(initialCell);
    activeCellRef.current = initialCell;
    moveSpringToCell(initialCell);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (models.length === 0 || efforts.length === 0) return;
    const { row, col } = activeCellRef.current;
    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        const nextRow = (row - 1 + models.length) % models.length;
        const nextCol = nearestValidCol(nextRow, desiredColRef.current);
        const next = { row: nextRow, col: nextCol };
        setHasInteracted(true);
        setActiveCell(next);
        activeCellRef.current = next;
        moveSpringToCell(next);
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        e.stopPropagation();
        const nextRow = (row + 1) % models.length;
        const nextCol = nearestValidCol(nextRow, desiredColRef.current);
        const next = { row: nextRow, col: nextCol };
        setHasInteracted(true);
        setActiveCell(next);
        activeCellRef.current = next;
        moveSpringToCell(next);
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        e.stopPropagation();
        const valid = rowValidCols[row] ?? [0];
        const pos = valid.indexOf(col);
        const nextCol = valid[pos > 0 ? pos - 1 : valid.length - 1];
        const next = { row, col: nextCol };
        setHasInteracted(true);
        setActiveCell(next);
        activeCellRef.current = next;
        desiredColRef.current = nextCol;
        moveSpringToCell(next);
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        e.stopPropagation();
        const valid = rowValidCols[row] ?? [0];
        const pos = valid.indexOf(col);
        const nextCol = valid[(pos + 1) % valid.length];
        const next = { row, col: nextCol };
        setHasInteracted(true);
        setActiveCell(next);
        activeCellRef.current = next;
        desiredColRef.current = nextCol;
        moveSpringToCell(next);
        break;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        e.stopPropagation();
        commitCell(activeCellRef.current);
        break;
      }
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      }
    }
  };

  const safeRow = Math.min(activeCell.row, Math.max(0, models.length - 1));
  const safeCol = nearestValidCol(safeRow, activeCell.col);

  const showActiveOrb = isActiveGroup || isDragging || hasInteracted;
  // True when browsing an inactive provider tab at rest (not hovered, not dragged):
  // keep readout & marker quiet so the popover never pretends this provider is active.
  const isRestingInactiveTab = !showActiveOrb && !hoverCell;

  const displayCell = !isDragging && hoverCell ? hoverCell : { row: safeRow, col: safeCol };
  const displayRow = Math.min(displayCell.row, Math.max(0, models.length - 1));
  const displayCol = nearestValidCol(displayRow, displayCell.col);
  const displayModel = models[displayRow];
  const displayEffort = efforts[displayCol];
  const activeValidCols = new Set(rowValidCols[displayRow] ?? []);

  // Continuously interpolated palette at the live floating-point puck X coordinate.
  const livePalette = useMemo<EffortPalette>(() => {
    if (effortPalettes.length === 0) return EFFORT_PALETTES.default;
    const clampedX = Math.max(0, Math.min(effortPalettes.length - 1, puckPos.x));
    const i0 = Math.floor(clampedX);
    const i1 = Math.min(effortPalettes.length - 1, i0 + 1);
    const frac = clampedX - i0;
    const p0 = effortPalettes[i0] ?? EFFORT_PALETTES.default;
    const p1 = effortPalettes[i1] ?? p0;
    return {
      core: lerpRgb(p0.core, p1.core, frac),
      highlight: lerpRgb(p0.highlight, p1.highlight, frac),
      deep: lerpRgb(p0.deep, p1.deep, frac),
    };
  }, [effortPalettes, puckPos.x]);

  const headerPalette = !isDragging && hoverCell
    ? (effortPalettes[displayCol] ?? livePalette)
    : livePalette;
  const snapTargetPalette = effortPalettes[safeCol] ?? livePalette;

  const showCommittedRing =
    committedCell !== null &&
    (committedCell.row !== safeRow || committedCell.col !== safeCol || isDragging);
  const committedPalette = committedCell
    ? (effortPalettes[committedCell.col] ?? EFFORT_PALETTES.default)
    : livePalette;

  const orbLeftPct = efforts.length > 0 ? ((puckPos.x + 0.5) / efforts.length) * 100 : 50;
  const orbTopPx = (puckPos.y + 0.5) * MATRIX_ROW_HEIGHT;
  const snapLeftPct = efforts.length > 0 ? ((safeCol + 0.5) / efforts.length) * 100 : 50;
  const snapTopPx = (safeRow + 0.5) * MATRIX_ROW_HEIGHT;
  const showSnapTargetCue = isDragging && Math.hypot(puckPos.x - safeCol, puckPos.y - safeRow) > 0.16;

  const committedLeftPct =
    committedCell && efforts.length > 0 ? ((committedCell.col + 0.5) / efforts.length) * 100 : 50;
  const committedTopPx = committedCell ? (committedCell.row + 0.5) * MATRIX_ROW_HEIGHT : 0;

  const hoverPalette = hoverCell ? (effortPalettes[hoverCell.col] ?? EFFORT_PALETTES.default) : null;
  const hoverLeftPct = hoverCell && efforts.length > 0 ? ((hoverCell.col + 0.5) / efforts.length) * 100 : 50;
  const hoverTopPx = hoverCell ? (hoverCell.row + 0.5) * MATRIX_ROW_HEIGHT : 0;

  const hasFooter = otherModels.length > 0 || Boolean(note);

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col select-none"
      data-testid="model-effort-pad"
      data-group={groupLabel ?? ''}
      data-active-group={isActiveGroup ? 'true' : 'false'}
    >
      {/* Header: Model (left) and Effort (right) updating live */}
      <div className="flex items-end justify-between gap-4 border-b border-white/[0.07] px-3.5 sm:px-5 pt-3 pb-2.5">
        <div className="min-w-0">
          <div className="text-[11px] font-medium leading-none text-composer-text-faint mb-1.5">
            {isRestingInactiveTab ? 'Default model' : 'Model'}
          </div>
          <div
            className={cn(
              'truncate text-[16px] sm:text-[17px] font-semibold tracking-[-0.01em] leading-tight transition-colors duration-150',
              isRestingInactiveTab ? 'text-composer-text/55' : 'text-composer-text',
            )}
            data-testid="matrix-active-model"
          >
            {displayModel?.label ?? ''}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] font-medium leading-none text-composer-text-faint mb-1.5">
            Effort
          </div>
          <div
            className={cn(
              'text-[16px] sm:text-[17px] font-semibold tracking-[-0.01em] leading-tight',
              !isDragging && 'transition-colors duration-150',
              isRestingInactiveTab && 'text-composer-text-secondary/65',
            )}
            style={
              isRestingInactiveTab
                ? undefined
                : { color: `rgb(${rgbStr(headerPalette.core)})` }
            }
            data-testid="matrix-active-effort"
          >
            {displayEffort?.label ?? ''}
          </div>
        </div>
      </div>

      {/* Body: overflow-hidden clips ambient glow cleanly to the matrix region (never bleeds over header hairline) */}
      <div className="relative flex flex-1 flex-col justify-center overflow-hidden px-3.5 sm:px-5 pt-2 pb-3.5">
        <div className="flex items-stretch">
          {/* Y-axis: right-aligned model labels snug against dot column 0 */}
          <div
            className="flex w-[94px] sm:w-[130px] shrink-0 flex-col pr-2.5 sm:pr-4"
            style={{ paddingTop: MATRIX_PAD_Y, paddingBottom: MATRIX_PAD_Y }}
          >
            {models.map((model, rIdx) => {
              const isRowActive = showActiveOrb && rIdx === safeRow;
              const isRowHovered = !isDragging && hoverCell?.row === rIdx;
              const isRowPreview = isRestingInactiveTab && rIdx === displayRow;
              return (
                <button
                  key={model.id}
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    const col = nearestValidCol(rIdx, desiredColRef.current);
                    setHasInteracted(true);
                    setActiveCell({ row: rIdx, col });
                    activeCellRef.current = { row: rIdx, col };
                    moveSpringToCell({ row: rIdx, col });
                    commitCell({ row: rIdx, col });
                  }}
                  onMouseEnter={() => {
                    if (!isDragging) {
                      const col = nearestValidCol(rIdx, desiredColRef.current);
                      setHoverCell({ row: rIdx, col });
                    }
                  }}
                  onMouseLeave={() => {
                    if (!isDragging) setHoverCell(null);
                  }}
                  title={model.description ?? model.label}
                  style={{ height: MATRIX_ROW_HEIGHT }}
                  className={cn(
                    'flex w-full items-center justify-end truncate text-right text-[12px] sm:text-[13px] leading-none transition-colors duration-150 cursor-pointer outline-none',
                    isRowActive || isRowHovered
                      ? 'font-medium text-composer-text'
                      : isRowPreview
                        ? 'font-medium text-composer-text-secondary'
                        : model.other
                          ? 'text-composer-text-faint hover:text-composer-text-secondary'
                          : 'text-composer-text-secondary/80 hover:text-composer-text',
                  )}
                  data-testid={`model-option-${model.id}`}
                >
                  <span className="truncate">{model.label}</span>
                </button>
              );
            })}
          </div>

          {/* Open 2D dot field — right padding lets rightmost column glow decay softly */}
          <div
            ref={padSurfaceRef}
            role="grid"
            tabIndex={0}
            aria-label={`${groupLabel ?? 'Model'} and effort selector`}
            onKeyDown={handleKeyDown}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={() => {
              if (!isDragging) setHoverCell(null);
            }}
            style={{
              paddingTop: MATRIX_PAD_Y,
              paddingBottom: MATRIX_PAD_Y,
            }}
            className={cn(
              'relative min-w-0 flex-1 pr-1 sm:pr-2 touch-none outline-none rounded-xl',
              'focus-visible:ring-1 focus-visible:ring-white/20',
              isDragging ? 'cursor-grabbing' : 'cursor-pointer',
            )}
            data-testid="matrix-pad-surface"
          >
            {/* Inner coordinate box: dots, light wash, rings, and orb share this exact origin */}
            <div
              ref={padInnerRef}
              className="relative w-full"
              style={{ height: models.length * MATRIX_ROW_HEIGHT }}
            >
              {/* Subtle separator between adaptive Default column and explicit Low..Max ramp */}
              {hasLeadingDefaultCol && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-2 bottom-2 w-px bg-white/[0.06]"
                  style={{ left: `${(1 / efforts.length) * 100}%` }}
                />
              )}

              {/* Ambient light field under the active/dragged orb — tuned so it decays softly before borders */}
              {showActiveOrb && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${orbLeftPct}%`,
                    top: `${orbTopPx}px`,
                    width: isDragging ? 228 : 196,
                    height: isDragging ? 228 : 196,
                    background: `radial-gradient(circle, ${rgbaStr(livePalette.core, isDragging ? 0.34 : 0.25)} 0%, ${rgbaStr(livePalette.core, isDragging ? 0.12 : 0.08)} 36%, ${rgbaStr(livePalette.core, 0)} 68%)`,
                    transition: 'width 180ms ease, height 180ms ease',
                  }}
                />
              )}

              {/* Soft secondary hover bloom so the field wakes up under the cursor */}
              {!isDragging && hoverCell && hoverPalette && (!showActiveOrb || hoverCell.row !== safeRow || hoverCell.col !== safeCol) && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left,top] duration-150 ease-out"
                  style={{
                    left: `${hoverLeftPct}%`,
                    top: `${hoverTopPx}px`,
                    width: 124,
                    height: 124,
                    background: `radial-gradient(circle, ${rgbaStr(hoverPalette.core, 0.2)} 0%, ${rgbaStr(hoverPalette.core, 0)} 68%)`,
                  }}
                />
              )}

              {/* Dots + crisp intentional micro-dashes for unsupported ragged slots */}
              {models.map((model, rIdx) => {
                const validCols = new Set(rowValidCols[rIdx] ?? []);
                return efforts.map((eff, cIdx) => {
                  const leftPct = `${((cIdx + 0.5) / efforts.length) * 100}%`;
                  const topPx = `${(rIdx + 0.5) * MATRIX_ROW_HEIGHT}px`;

                  if (!validCols.has(cIdx)) {
                    return (
                      <span
                        key={`${model.id}-${eff.id}-na`}
                        aria-hidden
                        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                        style={{
                          left: leftPct,
                          top: topPx,
                          width: 6,
                          height: 1.5,
                          backgroundColor: 'rgba(232, 230, 227, 0.20)',
                        }}
                      />
                    );
                  }

                  const cellPalette = effortPalettes[cIdx] ?? EFFORT_PALETTES.default;
                  const dist = showActiveOrb ? Math.hypot(rIdx - puckPos.y, cIdx - puckPos.x) : 99;
                  const prox = showActiveOrb ? smoothstep(2.5, 0, dist) : 0;
                  const hoverDist = !isDragging && hoverCell ? Math.hypot(rIdx - hoverCell.row, cIdx - hoverCell.col) : 99;
                  const hoverProx = !isDragging && hoverCell ? smoothstep(1.8, 0, hoverDist) : 0;
                  const isHovered = !isDragging && hoverCell?.row === rIdx && hoverCell?.col === cIdx;
                  const isCurrent = showActiveOrb && rIdx === safeRow && cIdx === safeCol;

                  // Keep each dot faithful to its semantic effort hue (subtle 18% ambient orb warmth).
                  const litRgb = lerpRgb(cellPalette.core, livePalette.core, 0.18);
                  const baseLight = Math.max(prox, hoverProx * 0.72);
                  const size = isHovered
                    ? 9.5
                    : 5.5 + prox * 2.8 + hoverProx * 1.6;

                  let dotBg: string;
                  if (isHovered) {
                    dotBg = `rgb(${rgbStr(cellPalette.core)})`;
                  } else if (prox > 0.04) {
                    dotBg = rgbaStr(litRgb, 0.28 + prox * 0.68);
                  } else if (hoverProx > 0.04) {
                    dotBg = rgbaStr(cellPalette.core, 0.28 + hoverProx * 0.56);
                  } else {
                    dotBg = 'rgba(232, 230, 227, 0.25)';
                  }

                  return (
                    <span
                      key={`${model.id}-${eff.id}`}
                      data-testid={`matrix-cell-${model.id}-${eff.id}`}
                      data-active={isCurrent ? 'true' : undefined}
                      aria-hidden
                      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{
                        left: leftPct,
                        top: topPx,
                        width: size,
                        height: size,
                        backgroundColor: dotBg,
                        boxShadow: isHovered
                          ? `0 0 0 5px ${rgbaStr(cellPalette.core, 0.2)}, 0 0 14px ${rgbaStr(cellPalette.core, 0.55)}`
                          : baseLight > 0.45
                            ? `0 0 ${Math.round(baseLight * 10)}px ${rgbaStr(litRgb, baseLight * 0.38)}`
                            : undefined,
                        transition: isDragging ? undefined : 'width 140ms ease, height 140ms ease, background-color 140ms ease, box-shadow 140ms ease',
                      }}
                    />
                  );
                });
              })}

              {/* Subtle snap-target ring under the cell that will catch the orb if released mid-drag */}
              {showSnapTargetCue && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${snapLeftPct}%`,
                    top: `${snapTopPx}px`,
                    width: 15,
                    height: 15,
                    border: `1.5px solid ${rgbaStr(snapTargetPalette.core, 0.52)}`,
                    backgroundColor: rgbaStr(snapTargetPalette.core, 0.1),
                  }}
                />
              )}

              {/* Solid hollow ring marking the committed origin cell while dragging elsewhere */}
              {showCommittedRing && (
                <span
                  aria-hidden
                  data-testid="matrix-committed-ring"
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${committedLeftPct}%`,
                    top: `${committedTopPx}px`,
                    width: 19,
                    height: 19,
                    border: `1.5px solid ${rgbaStr(committedPalette.core, 0.72)}`,
                    backgroundColor: rgbaStr(committedPalette.core, 0.08),
                  }}
                />
              )}

              {/* Dashed neutral marker on an inactive provider tab (clearly distinct from active orb and drag-origin ring) */}
              {!showActiveOrb && (
                <span
                  aria-hidden
                  data-testid="matrix-preview-knob"
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${orbLeftPct}%`,
                    top: `${orbTopPx}px`,
                    width: 20,
                    height: 20,
                    border: '1.5px dashed rgba(232, 230, 227, 0.34)',
                    backgroundColor: 'rgba(232, 230, 227, 0.05)',
                  }}
                />
              )}

              {/* Tactile backlit glass orb — continuously tracked & spring-settled */}
              {showActiveOrb && (
                <span
                  aria-hidden
                  data-testid="matrix-orb"
                  className={cn(
                    'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height] duration-150',
                    isDragging ? 'size-[27px] sm:size-[30px]' : 'size-[24px] sm:size-[27px]',
                  )}
                  style={{
                    left: `${orbLeftPct}%`,
                    top: `${orbTopPx}px`,
                    background: orbBackground(livePalette),
                    boxShadow: [
                      `0 0 0 1px ${rgbaStr(livePalette.highlight, 0.32)}`,
                      `0 0 ${isDragging ? 26 : 20}px ${rgbaStr(livePalette.core, isDragging ? 0.64 : 0.45)}`,
                      `0 6px 14px rgba(0, 0, 0, 0.54)`,
                      `inset 0 2px 3px ${rgbaStr(livePalette.highlight, 0.62)}`,
                      `inset 0 -3px 6px rgba(0, 0, 0, 0.24)`,
                    ].join(', '),
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* X-axis: effort labels aligned directly under dot columns */}
        <div className="mt-1 flex items-center">
          <div className="w-[94px] sm:w-[130px] shrink-0 pr-2.5 sm:pr-4" />
          <div
            className="grid min-w-0 flex-1 pr-1 sm:pr-2"
            style={{ gridTemplateColumns: `repeat(${efforts.length}, minmax(0, 1fr))` }}
          >
            {efforts.map((eff, cIdx) => {
              const supported = activeValidCols.has(cIdx);
              const isColActive = showActiveOrb && cIdx === safeCol;
              const isColHovered = !isDragging && hoverCell?.col === cIdx;
              const isColPreview = isRestingInactiveTab && cIdx === displayCol;
              const mobileLabel = eff.shortLabel ?? MOBILE_EFFORT_LABELS[eff.id] ?? eff.label;
              return (
                <button
                  key={eff.id}
                  type="button"
                  tabIndex={-1}
                  disabled={!supported}
                  onClick={() => {
                    if (!supported) return;
                    setHasInteracted(true);
                    setActiveCell({ row: displayRow, col: cIdx });
                    activeCellRef.current = { row: displayRow, col: cIdx };
                    desiredColRef.current = cIdx;
                    moveSpringToCell({ row: displayRow, col: cIdx });
                    commitCell({ row: displayRow, col: cIdx });
                  }}
                  onMouseEnter={() => {
                    if (!isDragging && supported) {
                      setHoverCell({ row: displayRow, col: cIdx });
                    }
                  }}
                  onMouseLeave={() => {
                    if (!isDragging) setHoverCell(null);
                  }}
                  title={eff.description ?? eff.label}
                  className={cn(
                    'flex items-center justify-center rounded py-1.5 text-center text-[10.5px] sm:text-[11.5px] leading-none whitespace-nowrap transition-colors duration-150 outline-none',
                    !supported
                      ? 'cursor-default text-composer-text-faint/35'
                      : isColActive || isColHovered
                        ? 'cursor-pointer font-medium text-composer-text'
                        : isColPreview
                          ? 'cursor-pointer font-medium text-composer-text-secondary'
                          : 'cursor-pointer text-composer-text-secondary/80 hover:text-composer-text',
                  )}
                  data-testid={`effort-option-${eff.id}`}
                >
                  <span className="hidden sm:inline">{eff.label}</span>
                  <span className="sm:hidden">{mobileLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer rendered only when Older models or a note exists — zero filler helper prose */}
      {hasFooter && (
        <div className="border-t border-white/[0.06] px-3.5 sm:px-5 py-2.5">
          {otherModels.length > 0 && (
            <button
              type="button"
              tabIndex={-1}
              onClick={onToggleOtherModels}
              data-testid="model-menu-other"
              className="flex items-center gap-1 rounded py-0.5 text-[11.5px] text-composer-text-secondary/85 transition-colors hover:text-composer-text cursor-pointer outline-none"
            >
              <span>{showOtherModels ? 'Hide older models' : 'Older models'}</span>
              {showOtherModels
                ? <ChevronUp size={13} aria-hidden />
                : <ChevronDown size={13} aria-hidden />}
            </button>
          )}
          {note && (
            <p
              className="composer-model-menu-note pt-1 text-[11px] leading-snug text-composer-text-faint"
              data-testid="model-menu-note"
            >
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
