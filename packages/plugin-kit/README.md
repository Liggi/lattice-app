# @liggi/lattice-plugin-kit

What a Lattice plugin is built against: the contract's types, the shims that
give a plugin the page's own React, Lattice's colour and font names for
Tailwind, and a build helper.

A plugin runs inside Lattice with all of its access to your sessions, files
and keys. There is no sandbox.

## A plugin's package

```json
{
  "name": "my-lattice-plugin",
  "version": "1.0.0",
  "type": "module",
  "lattice": { "id": "my-plugin", "api": 1, "server": "dist/server.js", "web": "dist/web.js", "css": "dist/web.css" }
}
```

`id` names its routes (`/api/plugins/<id>`), pages (`/p/<id>`) and data
folder (`~/.lattice-app/plugin-data/<id>`). Each entry is optional.

## Server

```ts
import type { LatticePluginHost } from '@liggi/lattice-plugin-kit';

export default function activate(host: LatticePluginHost) {
  host.router.get('/status', (_req, res) => res.json({ ok: true }));
  const timer = setInterval(poll, 5_000);
  host.onStop(() => clearInterval(timer));

  // An agent runs: lattice plugin my-plugin draft --session <conv> --to x <<'EOF' … EOF
  host.command('draft', ({ session, args, text }) => {
    host.confirm.ask(session, {
      question: `Send this to ${args.to}?`,
      detail: text,
      options: [{ label: 'Send', consequence: 'It is sent.' }, { label: "Don't send", consequence: 'Nothing is sent.' }],
      runs: 'Send',
    }, { name: 'send', payload: { to: args.to, text } });
    return 'The draft is on a card. End your turn.';
  });
  host.confirm.handle('send', async (payload) => { /* send it */ return 'Sent.'; });
}
```

A card's action runs once, when the user chooses `runs` on the Lattice page,
and survives a restart. `host.sessions.create({ message, title })` starts a
session named `title`. Write a command into an agent's instructions as
`${host.cli} plugin my-plugin draft`: agents' shells do not have `lattice` on
PATH.

## Web

```tsx
import type { LatticeWebHost } from '@liggi/lattice-plugin-kit';

export default function activate(web: LatticeWebHost) {
  web.page('/', MyPage, { title: 'My plugin' });
  web.sidebarLink({ label: 'My plugin', path: '/', icon: MyIcon, useBadge: () => '3 new' });
}
```

The web entry is imported by the page at runtime, so it must be one bundled
module that imports `react` without bundling it; the build helper does that.
Its stylesheet starts with:

```css
@import "@liggi/lattice-plugin-kit/plugin.css";
@source "./";
```

Its classes apply only on the plugin's own pages, where `bg-surface-2`,
`text-fg-3` and the rest mean what they mean in Lattice.

## Build

```sh
lattice-plugin-build --server src/server.ts --web src/web.tsx --css src/web.css
```

`test/fixtures/plugins/hello-plugin` in the Lattice repo is a small complete
example.
