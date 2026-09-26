# agent-ui-toolkit

Shared component library for rendering Claude Code tool events. Sits between the protocol layer (agent-ui-harness) and product UIs such as Lattice.

```
agent-ui-harness   (protocol: events, classify, group, extract)
       ↓
agent-ui-toolkit   (components: tool cards, groups, result renderers)
       ↓
lattice / analyst  (product: layout, state, themes, API integration)
```

## Quick start

```bash
pnpm install
pnpm build        # compile to dist/
pnpm typecheck    # type check without emitting
pnpm test         # run vitest
pnpm storybook    # launch Storybook dev server
```

## Architecture

- **`tokens.ts`** — structural design tokens (light/dark). Light mode is default, `dark:` Tailwind variant for dark mode. Consumer sets `class="dark"` on a parent.
- **`context.tsx`** — `ToolkitProvider` for theme (shiki code highlighting) and `resolveAgentColor` (team color lookup).
- **`ToolContent.tsx`** — routing switch: tool name → component. Accepts `customRenderers` for consumer-defined tools.
- **`ToolUseRenderer.tsx`** — main entry point. Wraps ToolContent with ErrorBoundary.
- **`CollapsibleToolCard.tsx`** — shared card wrapper used by all tool components.

## Extension point

Consumers pass `customRenderers` to override or add tool renderers:

```tsx
<ToolUseRenderer
  customRenderers={{
    'mcp__notion__search': (props) => <NotionSearchCards {...props} />,
  }}
/>
```

All building blocks (CollapsibleToolCard, CodeHighlight, DiffViewer, prose classes) are exported for custom tool cards.

## Product-specific inversions

These Lattice-specific concerns are abstracted to callbacks/context:
- `useTeamColor()` → `resolveAgentColor` on ToolkitProvider context
- `api.resumeConversation()` → `onPlanApprove`/`onPlanReject` props on ToolContent
- `/api/filesystem/task-output` → `fetchBackgroundOutput` prop on ToolContent

## Key invariants

- No product-specific code in this package
- Accent colors (per-tool tints) are transparent and work on both light/dark backgrounds
- All tool components use CollapsibleToolCard for consistent card chrome
- Shiki theme selected via ToolkitProvider context, not hardcoded
