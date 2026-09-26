# The host-integration marker

`<config dir>/host-integration.json` decides whether a Lattice instance may
write the machine's shared Claude Code state. Without it an instance runs
normally but changes nothing outside its own config dir.

## Why it exists

Three of the things Lattice writes are not inside its config dir. They live in
`~/.claude` and every Claude process on the machine reads them:

- the `PreToolUse` and `PermissionRequest` HTTP hooks in `~/.claude/settings.json`
- the `toolPermissions` allow-list in the same file
- `~/.claude/hooks/pre-compact-hook.sh`

Each carries the writing server's own port, so the last server to write owns
the whole fleet's hook traffic.

On 2026-09-21 a worker started a throwaway server on port 3099 with
`LATTICE_CONFIG_DIR` pointed at a temp dir. That isolates the database and
nothing else: `ClaudeSettingsService` resolves `os.homedir()` directly. The
fixture repointed the machine's hooks at itself, every live Claude worker
opened a socket to 3099 to serve them, and the fixture's own cleanup —
`lsof -ti:3099 | xargs kill`, which selects connected clients as well as the
listener — killed four unrelated workers along with it.

## Why a file and not an environment variable

A server passes its environment to its workers, and a worker that launches a
server passes it on again, so a flag meant to mark "this is the real instance"
arrives at exactly the process it was meant to exclude. That is the same
inheritance that defeated `LATTICE_CONFIG_DIR`. Nothing in the authority
decision reads the environment.

The marker names the config dir it was issued for, and authority requires that
name to match the dir the marker was found in. A copied config dir carries a
marker still naming the original path, so the copy gets nothing. A bare
`{ "manageClaudeSettings": true }` would have travelled with any `cp -r`.

## Fields

```json
{
  "manageClaudeSettings": true,
  "configDir": "/Users/you/.lattice-app",
  "daemonSocket": "/Users/you/.lattice-app/daemon.sock"
}
```

- `manageClaudeSettings` — must be exactly `true`. Anything else denies.
- `configDir` — must be absolute, must exist, and must resolve through
  `realpath` to the same directory the marker sits in. A relative path is
  refused outright: it would be read against whatever working directory the
  process happens to have, so the same file would grant authority from one cwd
  and withhold it from another.
- `daemonSocket` — optional. When present and authority is granted, this is the
  daemon socket the instance uses, whether or not `LATTICE_DAEMON_SOCKET` is
  set in the environment. When absent, or when authority is denied, the
  instance uses `<config dir>/daemon.sock`.

If either path cannot be resolved — a dangling symlink, a deleted directory, a
permission error on a parent — authority is denied and no socket is taken from
the marker. There is deliberately no fall back to textual comparison: if we
cannot say which directory a path names, we cannot say it is the one the marker
was issued for.

## On a fresh install

No marker is created for you. A new instance starts and serves its UI
normally, and logs one warning naming the file it did not find:

    Not managing shared Claude hooks for this instance;
    ASK-mode permissions will not reach it

That line is written at startup (`lattice-server.ts` calls
`ensureManagedClaudeHooks` in its init sequence) and again on every
conversation spawn (`unified-conversation.lifecycle-routes.ts`). Its absence
from a startup log is therefore a usable check that an instance does hold
authority. Nothing else announces the denial: ASK-mode permission prompts
simply do not reach the instance, because they arrive through the shared
hooks.

It is worth grepping for more than the sentence. The warning carries three
structured fields, and they answer the next question without a second look:

- `baseUrl` — which instance is reporting
- `reason` — `authority.deniedReason`, so "no host-integration marker at
  /path" reads differently from "marker was issued for X, not Y". Missing and
  present-but-not-authoritative are different problems.
- `marker` — the absolute path of the file that was consulted. Note the field
  is named `marker`, not `markerPath`, though it carries `authority.markerPath`.

Creating one is deliberately an operator action. A server that wrote its own
marker when it found none would restore the original hazard on first run: the
fixture would have written one too.

To grant an instance that authority, write the file into its config dir with
`configDir` set to that same directory:

```sh
cat > ~/.lattice-app/host-integration.json <<'JSON'
{
  "manageClaudeSettings": true,
  "configDir": "/Users/you/.lattice-app"
}
JSON
```

Only one instance on a machine should hold it. Two instances with markers do
not partition the hooks between them — the hooks carry a single port, so the
last one to write owns all of it. The older npm release (`lattice-orchestrator`)
writes its hooks on every start without asking for a marker, so on a machine
that also runs it, a marker here starts the same contest.

## Deleting the marker on a running install

Removing the marker from a config dir that has one does two things, and the
second is easy to miss (the first is at least announced in the log):

1. The instance stops writing shared `~/.claude` state, which is the intended
   effect.
2. Its daemon socket moves from the path the marker declared to
   `<config dir>/daemon.sock`. A daemon still listening on the old path is
   orphaned — nothing is killed, but the next server start will not find it and
   will start another.

So on an install whose marker declares a socket, treat the file as part of the
runtime configuration rather than as a permission toggle that can be flipped
back and forth while things are running.

## Proposed: issuing the marker from the CLI

Writing JSON by hand is the current answer and it is a poor one for a fresh
install. A `lattice host-integration grant` command would be better, under
constraints that keep it from recreating the hazard:

- it requires an explicitly selected config dir and endpoint; it never infers
  them from the environment or from the process's own config dir
- it canonicalizes the selected directory before writing, so the file records
  the path the authority check will compare against
- it is never invoked automatically, and in particular never in response to the
  startup warning about a missing marker — the whole point is that a running
  server cannot grant itself this

This section is a proposal. Nothing implements it yet.
