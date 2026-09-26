# Lattice

Lattice is a self-hosted web workspace for running coding agents on your projects. You talk to a coordinator for each project; it dispatches workers, keeps a shared record of what has been decided, and reports back. It runs on your own machine with your own Claude Code and Codex logins, and works from a desktop or phone browser (over Tailscale, for example). You can move a project's coordinator between models and keep its context.

Lattice is pre-release software.

## Requirements

- macOS or Linux
- Node.js 22 or newer (tested on 24 and 26)
- At least one of these agent CLIs, installed on the same machine:
  - [Claude Code](https://code.claude.com/docs/en/setup) (`claude`)
  - [Codex](https://learn.chatgpt.com/docs/codex/cli) (`codex`)

You sign each CLI in with your own account. Lattice never sees a password; it runs the CLIs you already have.

## Install

```bash
npm install -g lattice-app
```

This installs the `lattice-app` command. To work on Lattice itself, build it from a clone instead; see [Development](#development).

## Run

```bash
lattice-app                  # start the server on port 3001
lattice-app --port 3100      # another port
```

Open http://localhost:3001 (or your port). The server keeps running in that terminal; stop it with Ctrl+C. Run it inside `tmux` or `screen`, or under your own service manager, if it should outlive the terminal.

Settings and data live in `~/.lattice-app/`. Set `LATTICE_CONFIG_DIR` to keep them somewhere else, for example to run a second instance on another port.

Already running the older Lattice from npm? See [Running next to an existing Lattice](#running-next-to-an-existing-lattice).

## Running next to an existing Lattice

If you already use the older Lattice from npm (the `lattice-orchestrator` package, with the global `lattice` command and data in `~/.lattice`), you can install this one beside it without uninstalling anything. They are separate npm packages with separate commands, `lattice` and `lattice-app`, and they don't share files, a daemon or a port:

- This Lattice keeps everything in `~/.lattice-app/`: settings, sessions, logs, its daemon's socket, and the `lattice` command its coordinators dispatch workers with. It never reads or writes `~/.lattice`.
- Its agents call that command by its full path, so they reach this server even though the old `lattice` is on your PATH. In a terminal, `lattice` is still the old one and `lattice-app` is this one.

Both default to port 3001, and this one refuses to start while the old one holds it. Pick another port once, before you start it:

```bash
mkdir -p ~/.lattice-app
echo '{ "server": { "port": 3101 } }' > ~/.lattice-app/config.json
lattice-app
```

Then open http://localhost:3101. Lattice adds its other settings to that file on first run.

To stop or restart either one, stop it the way you started it; the other keeps running and keeps its sessions. `npm update -g lattice-app` and `npm update -g lattice-orchestrator` each update only their own package. To remove this one, run `npm uninstall -g lattice-app` and delete `~/.lattice-app/`.

Two things are shared, because they belong to your user account rather than to either Lattice:

- **Claude hooks.** The old Lattice registers hooks in `~/.claude/settings.json` that point at its port, so this Lattice's Claude workers call it on every tool use. While it is running it answers "no opinion" for sessions it doesn't know. While it is stopped, each call fails immediately and Claude carries on. Either way, this Lattice's workers run normally. Don't create the host-integration marker ([docs/host-integration-marker.md](docs/host-integration-marker.md)) for this Lattice while the old one is installed: the two would keep overwriting each other's hooks.
- **Tailscale.** `tailscale serve --bg 3101` replaces whatever is served at your machine's Tailscale address, which is probably the old Lattice. To keep both reachable from your phone, serve this one on another HTTPS port: `tailscale serve --bg --https=8443 3101`, then open `https://your-machine.your-tailnet.ts.net:8443`. **Settings → Access** and the startup log check what Tailscale already serves and give you this form, with a free port, when 443 is taken.

## Your first project

1. **Sign in.** The start screen shows whether Claude and Codex are signed in. Click one that isn't to open **Settings → Providers**. For Claude, **Connect** opens Claude Code's own sign-in in a terminal inside the page: tap the link it prints, sign in to Claude, then paste the code back at its prompt. The CLI does the exchange and keeps the login; Lattice only carries what you type, like a web terminal. Signing in from a terminal with `claude` or `codex login` works too, and **Sign in again** renews an expired login the same way. You need one provider; Lattice works with just Claude or just Codex.

   Claude conversations run on that sign-in, that is, your Claude subscription. If you would rather be billed per token by Anthropic, choose **API key** under the Claude card and save a key; it is stored on this machine and never shown again. The same key powers summaries and quick answers, and saving it for those does not switch conversations to it unless you choose that.
2. **Choose the folder.** Under the session type, click the folder name and pick the folder your project lives in. Agents read and change files there. Lattice remembers the last folder you used.
3. **Start a coordinator.** Choose **Coordinator**, then pick whether it runs on Claude or Codex. Describe the outcome you want and send it.

The coordinator is the conversation you talk to. It agrees the goal with you, starts worker sessions (Claude or Codex) to do the work, and reports back in the same thread. It starts workers with a `lattice` command that the server writes to `~/.lattice-app/bin/lattice` each time it starts, so you don't need to install anything on your PATH.

To run a single agent without a coordinator, choose **Claude**, **Codex** or **OpenCode** instead.

⚠️ Agents run with permission prompts off by default (Claude's `bypassPermissions` mode; Codex runs with full access). They can run any command your user account can, in any folder. Point them only at work you're happy for an agent to do unattended.

## Use it from your phone with Tailscale

The server only listens on this machine (`127.0.0.1`). To reach it from your phone or another computer, use [Tailscale](https://tailscale.com):

1. Install Tailscale on the machine running Lattice and on your phone, and sign both into the same tailnet.
2. On the Lattice machine, run:

   ```bash
   tailscale serve --bg 3001
   ```

   With the Mac App Store version of Tailscale, `tailscale` is not on your PATH; use `/Applications/Tailscale.app/Contents/MacOS/Tailscale` in its place. **Settings → Access** shows the command with the right path for your machine; if something else is already served on your Tailscale address, it gives an `--https=<port>` form that leaves it alone.

   It prints an address like `https://your-machine.your-tailnet.ts.net`. Tailscale forwards it to Lattice, over HTTPS, and only devices on your tailnet can reach it.
3. Open that address on your phone. In Safari or Chrome you can add it to your home screen.

Anyone on your tailnet who can open that address can run agents as you, so check your tailnet's sharing and access rules. `tailscale serve reset` turns it off. Lattice has no login of its own yet: don't bind it to `0.0.0.0` or put it on the public internet.

**Settings → Access** shows the addresses Lattice can see and the command for your port.

## Configuration

`~/.lattice-app/config.json` is created on first run. Useful settings:

| Setting | What it does |
|---------|--------------|
| `server.port` | Port to listen on (default `3001`; `--port` overrides it) |
| `server.defaultWorkingDirectory` | Folder new sessions start in until you pick one |
| `server.defaultModel` | Claude model for new Claude sessions |
| `server.defaultPermissionMode` | Claude permission mode: `default` (ask), `acceptEdits`, `bypassPermissions`, `plan` |
| `coordinator.provider` | `claude` or `codex`: which one the Coordinator choice starts on |

Asking for permission (`default` mode) needs Lattice to register hooks in `~/.claude/settings.json`. It only does that for the instance you allow; see [docs/host-integration-marker.md](docs/host-integration-marker.md).

## Personal settings

Agents refer to you as "the user" unless you set a name. Standing guidance you want every coordinator or worker to follow goes here too:

```json
{
  "user": {
    "name": "Sam",
    "coordinatorGuidance": "Ask before changing a public API.",
    "workerGuidance": "Run the project's tests before reporting.",
    "projects": ["my-app", "my-library"]
  }
}
```

`projects` gives session summaries a list of project names to match against.

## Repository layout

| Path | What it is |
|------|------------|
| `src/` | The Lattice server, CLI and web app |
| `packages/harness` | `@liggi/agent-ui-harness`: runs an agent CLI process and streams its events to a browser |
| `packages/toolkit` | `@liggi/agent-ui-toolkit`: React components for rendering agent tool calls |

## Development

Building from a clone needs pnpm 10 as well as Node. Install pnpm with `npm install -g pnpm@10` or `brew install pnpm`. On Node 22–24 `corepack enable` also works; Node 25 and later no longer include corepack.

```bash
git clone <this repository> lattice
cd lattice
pnpm install     # also builds the bundled harness and toolkit packages
pnpm build
pnpm start       # same as: node dist/cli.js serve
```

A clone uses the same `~/.lattice-app/` data folder as the npm package, so stop one before starting the other, or give the clone its own folder with `LATTICE_CONFIG_DIR`. Don't `npm link` the clone next to an installed `lattice-app`: both provide the `lattice-app` command. `pnpm pack:release` builds the npm tarball from a built clone.

```bash
pnpm typecheck
pnpm lint
pnpm test:unit        # app unit tests
pnpm test:packages    # harness and toolkit tests
pnpm test             # Playwright behavioural tests (needs `npx playwright install`)
pnpm dev              # server with reload on change, from source
```

`pnpm dev` runs from `src/` under `tsx` and reloads on changes. On Linux, `pnpm service:setup` installs optional systemd user services; the other `service:*` scripts manage them.

## Licence

Apache License 2.0; see [LICENSE](LICENSE). The harness and toolkit packages are MIT-licensed; see their own LICENSE files. Lattice began as a fork of [CUI](https://github.com/bmpixel/cui) by Wenbo Pan; see [NOTICE](NOTICE).
