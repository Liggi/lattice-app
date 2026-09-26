interface ParsePositiveIntQueryOptions {
  defaultValue?: number;
  min?: number;
  max?: number;
  allowZero?: boolean;
}

export function parsePositiveIntQuery(
  value: unknown,
  options: ParsePositiveIntQueryOptions = {}
): number | undefined {
  const {
    defaultValue,
    min,
    max,
    allowZero = false,
  } = options;

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  if (allowZero ? parsed < 0 : parsed <= 0) {
    return defaultValue;
  }

  let normalized = parsed;
  if (typeof min === 'number') {
    normalized = Math.max(min, normalized);
  }
  if (typeof max === 'number') {
    normalized = Math.min(max, normalized);
  }

  return normalized;
}
