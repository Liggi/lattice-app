/**
 * Client-side timeline milestone reporter.
 *
 * Reports lifecycle milestones (navigation, stream subscription, first event, etc.)
 * to the server's SessionTimeline via fire-and-forget POST.
 *
 * Always-on (no opt-in toggle) since milestones are low-volume and high-value
 * for debugging session lifecycle issues.
 */

/**
 * Report a timeline milestone for a known conversationId.
 */
export function reportMilestone(
  conversationId: string,
  milestone: string,
  fields?: Record<string, unknown>,
): void {
  sendMilestone({ conversationId, milestone, clientTimestamp: Date.now(), fields });
}

function sendMilestone(body: Record<string, unknown>): void {
  try {
    fetch('/api/timeline/milestone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      // Never break the app for timeline reporting
    });
  } catch {
    // Defensive — fetch itself shouldn't throw, but be safe
  }
}
