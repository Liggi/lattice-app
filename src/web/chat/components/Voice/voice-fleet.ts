/**
 * What the voice page calls.
 *
 * The Live session declares its tools to OpenAI and hands the resulting calls
 * back over the data channel for us to run, because they read the user's own
 * machine. This module executes one of those calls, plus the live status the
 * tools read the fleet with.
 */

const STATUS_ENDPOINT = '/api/sessions/status';
const TOOL_ENDPOINT = '/api/voice/tool';

export type StatusMap = Record<string, { status?: string; lastActivityAt?: string | null }>;

/**
 * Live status for the sessions we are about to describe.
 *
 * The ids are not optional. Called bare, `/api/sessions/status` returns only
 * what is in the active registry — measured: 9 of the 12 most recent
 * conversations came back absent — and every missing session then fell back to
 * `updatedAt`, a metadata write time rather than real activity. That is what
 * made the voice report a session's last activity as "yesterday morning" when
 * it was not.
 */
export async function fetchStatuses(ids: string[]): Promise<StatusMap> {
  if (ids.length === 0) return {};
  try {
    const response = await fetch(`${STATUS_ENDPOINT}?ids=${encodeURIComponent(ids.join(','))}`);
    if (!response.ok) return {};
    return ((await response.json()) as { sessions?: StatusMap }).sessions ?? {};
  } catch {
    return {};
  }
}

/** Conversation ids to ask about, newest first. */
export async function fetchFleetIds(limit = 25): Promise<string[]> {
  try {
    const response = await fetch(
      `/api/conv?limit=${limit}&archived=false&includeIdentityImage=false`,
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { conversations?: Array<{ conversationId: string }> };
    return (body.conversations ?? []).map((row) => row.conversationId);
  } catch {
    return [];
  }
}

/** Ids, then their status, then the roster built from both. */
export async function fetchFleetStatuses(limit = 25): Promise<StatusMap> {
  return fetchStatuses(await fetchFleetIds(limit));
}

/**
 * Execute one tool call the Live session handed back.
 *
 * Failures come back as a sentence rather than an exception: the model is
 * mid-answer with the user waiting, and it can say "I could not read that" — but
 * if the call is never answered it stalls or invents something.
 */
export async function runTool(
  name: string,
  args: string,
  statuses: StatusMap,
  workingDirectory: string,
): Promise<string> {
  try {
    const response = await fetch(TOOL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args, statuses, workingDirectory }),
    });
    if (!response.ok) return `That lookup failed (HTTP ${response.status}).`;
    return ((await response.json()) as { output?: string }).output ?? 'No result.';
  } catch (caught) {
    return `That lookup failed: ${caught instanceof Error ? caught.message : 'unknown error'}.`;
  }
}
