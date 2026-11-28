/**
 * What the shipping read could not check, in words for the panel. The server
 * records each failure with the tool's own error ("pull requests on
 * acme/web-app: HTTP 504: 504 Gateway Timeout (https://...)"); the
 * panel names the thing and the reason, and drops the plumbing.
 */
export function plainUnread(unread: readonly string[]): string[] {
  return [...new Set(unread.map(plainLine))];
}

function plainLine(line: string): string {
  const match = line.match(/^(pull requests on|checks on|branches in|npm release for) (.+?): (.*)$/s)
    ?? line.match(/^()([\w.-]+\/[\w.-]+ #\d+): (.*)$/s);
  if (!match) return line;
  const [, what, subject, error] = match;
  const name = /^\//.test(subject) ? subject.split('/').filter(Boolean).at(-1)! : subject;
  const target = what === 'branches in' ? `branches in ${name}`
    : what === 'npm release for' ? `the npm release for ${name}`
    : name;
  return `Couldn't check ${target} — ${reason(error, what === 'npm release for' || what === 'branches in' ? null : 'GitHub')}`;
}

function reason(error: string, service: string | null): string {
  const by = service ? `${service} ` : '';
  if (/\b504\b|gateway time-?out|timed out|ETIMEDOUT/i.test(error)) return `${by}timed out`;
  if (/\b50[023]\b|bad gateway|service unavailable/i.test(error)) return service ? `${service} was unavailable` : 'the service was unavailable';
  if (/rate limit/i.test(error)) return `${by}rate limit reached`;
  if (/\b401\b|gh auth login|authentication|not logged in/i.test(error)) return service ? `not signed in to ${service}` : 'not signed in';
  if (/ENOTFOUND|EAI_AGAIN|could not resolve host|network/i.test(error)) return 'no network connection';
  return error.replace(/^Command failed:.*$/m, 'the command failed').trim() || 'unknown error';
}
