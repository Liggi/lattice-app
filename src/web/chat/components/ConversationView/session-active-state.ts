export function shouldRefetchOnCompletion(
  wasOngoing: boolean,
  isOngoing: boolean,
): boolean {
  return wasOngoing && !isOngoing;
}
