import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to parse and convert query parameters to their proper types
 * 
 * This middleware automatically converts:
 * - Numeric strings to numbers
 * - Boolean strings ('true', 'false') to booleans
 * - Preserves other types as-is
 */
export function queryParser(req: Request, res: Response, next: NextFunction): void {
  if (!req.query || typeof req.query !== 'object') {
    return next();
  }

  const convertedQuery: Record<string, string | boolean | number | null | undefined | (string | boolean | number | null | undefined)[]> = {};

  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      convertedQuery[key] = value.map(v => convertValue(v));
    } else {
      convertedQuery[key] = convertValue(value);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
  req.query = convertedQuery as any; // Express query type expects string | string[], but we're converting to proper types
  next();
}

/**
 * Convert a single value to its appropriate type
 */
function convertValue(value: unknown): string | boolean | number | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  
  if (typeof value !== 'string') {
    return String(value);
  }

  if (value === '') {
    return value;
  }

  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!isNaN(num) && isFinite(num)) {
      return num;
    }
  }

  return value;
}