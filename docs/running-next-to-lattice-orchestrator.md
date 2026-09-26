# Running next to an existing Lattice

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

- **Claude hooks.** The old Lattice registers hooks in `~/.claude/settings.json` that point at its port, so this Lattice's Claude workers call it on every tool use. While it is running it answers "no opinion" for sessions it doesn't know. While it is stopped, each call fails immediately and Claude carries on. Either way, this Lattice's workers run normally. Don't create the host-integration marker ([docs/host-integration-marker.md](host-integration-marker.md)) for this Lattice while the old one is installed: the two would keep overwriting each other's hooks.
- **Tailscale.** `tailscale serve --bg 3101` replaces whatever is served at your machine's Tailscale address, which is probably the old Lattice. To keep both reachable from your phone, serve this one on another HTTPS port: `tailscale serve --bg --https=8443 3101`, then open `https://your-machine.your-tailnet.ts.net:8443`. **Settings → Access** and the startup log check what Tailscale already serves and give you this form, with a free port, when 443 is taken.

