# ChatGPT plan integration: source acceptance

Thread [51]. The coordinator accepted the tested source boundary and authorized
a scoped local commit. It is **not live**, and no real OAuth consent or
ChatGPT-plan inference has been performed.

## Implemented boundary

- Local loopback OAuth with fresh state, nonce and PKCE; signed issuer, account,
  audience, issued-client, resource and scope validation.
- Owner-only, atomic credentials; cross-process serialized refresh; protected CLI
  export/import that preserves the destination host ID and transfers refresh
  ownership. Browser responses contain status, not tokens.
- Explicit background routing shared by summaries, activity labels, insights,
  mission fitting and project naming. Repairs keep the complete conversation.
  Requests recheck the current route, including clients acquired before a switch.
- No paid API fallback, automatic credits permission, or automatic feature opt-ins.
  Usage-limit errors pause new requests. SSE must reach `response.completed` and
  finish without a later error before output is accepted.
- Account-specific model discovery and completed setup inference before routing
  activation. Actual returned models are recorded in generation provenance and a
  separate plan-token ledger; they never receive API-dollar estimates.
- Settings sign-in, account/model choice, first-use welcome, **Using ChatGPT plan**,
  **Manage usage**, explicit resume, disconnect and remote-setup instructions.

## Checks and evidence

All checks use Node 24.14.0, not the shell's Node 26.

- Focused Vitest run: **12 files, 169 tests passed**. Covers OAuth bindings and
  wrong accounts/scopes, credential permissions/import/refresh races, terminal
  versus temporary refresh failures, no fallback, SSE partial and late failures,
  catalog visibility, account-change activation, trusted-origin writes, config
  preservation, separate accounting, repairs/coalescing/stale labels and the
  retained Sonnet temperature regression.
- Server and web integrated typecheck passed. Vite build and server TypeScript
  compilation passed into an isolated directory, not the live assets. The final
  HTTP-error correction also passed server compilation and targeted ESLint.
- A compiled isolated server on `127.0.0.1:4318`, with a separate config, empty
  home and no API credentials, returned redacted disconnected status and zero
  plan usage. Cross-site disconnect returned **403**. Unverified config activation
  returned **409 / test_model_before_activation**, leaving API routing unchanged.
- Compiled CLI `status` returned only public state; unauthenticated `models`
  failed explicitly with `sign_in_required`.
- Real rendered Settings passed at 1200px desktop and 390px phone widths. Browser
  response fixtures exercised discovered choices, failed-stream non-activation,
  welcome dismissal/non-repetition, usage-limit/resume, disconnect without route
  fallback, declined-permission reauthorization and rejected-login popup cleanup.
  Reauthorization explicitly requests plan permission on the existing issued
  client and uses the same branded sign-in button. These are UI fixtures, not evidence
  of real OpenAI billing or inference.
- Screenshot evidence: `/tmp/lattice-plan-desktop.png`,
  `/tmp/lattice-plan-phone.png`, `/tmp/lattice-plan-connected-phone.png`,
  `/tmp/lattice-plan-limit-phone.png`, `/tmp/lattice-plan-welcome-desktop.png` and
  `/tmp/lattice-plan-welcome-phone.png` and
  `/tmp/lattice-plan-reauthorize-phone.png`. Each was visually inspected.
- No fixture conversations were created. At source acceptance, no commit, live
  restart, live asset swap, push, publication or benchmark interruption had been
  performed. The subsequently authorized local commit does not authorize a runtime update.

Detailed test/build logs remain under `/tmp/lattice-plan-*.log`. The in-app browser
was not available in this environment; isolated Chrome/Playwright provided visual
acceptance without any authentication bypass.

## Earlier held patch

The earlier Sonnet defaults and prompt-cache changes remain only on the explicit
Anthropic API route. They are not the selected plan model and are not a billing
fallback. Integration replaces their client acquisition and accounting with the
shared route and actual provenance. Unsupported `temperature` parameters were
removed from the retained Sonnet calls, with a repair-path regression assertion.
Existing quality guards and feature toggles remain in place.

The separately committed toolkit/model UI work was preserved.

## Changed paths

Authentication, routing and CLI:

- `src/services/infrastructure/chatgpt-plan-auth.ts`
- `src/services/infrastructure/chatgpt-plan-client.ts`
- `src/services/infrastructure/background-text-client.ts`
- `src/routes/integrations/chatgpt-plan.routes.ts`
- `src/cli/chatgpt-plan-command.ts`
- `src/cli-main.ts`
- `src/server/register-app-routes.ts`

Configuration, accounting and background generators:

- `src/types/config.ts`
- `src/services/infrastructure/config-service.ts`
- `src/services/infrastructure/generation-gates.ts`
- `src/services/infrastructure/cost-tracker.ts`
- `src/routes/system/config.routes.ts`
- `src/services/insights/insight-types.ts`
- `src/services/insights/anthropic-service.ts`
- `src/services/sessions/session-summary-service.ts`
- `src/services/sessions/session-review-service.ts`
- `src/services/sessions/turn-capture-service.ts`
- `src/services/sessions/worker-activity.ts`
- `src/services/sessions/worker-report-summary.ts`

Settings, setup and protection:

- `src/web/chat/components/SettingsDialog/ChatGPTPlanCard.tsx`
- `src/web/chat/components/SettingsDialog/ProviderAuthTab.tsx`
- `public/chatgpt-mark.svg`
- `.gitignore`
- `docs/chatgpt-plan.md`
- `docs/chatgpt-plan-acceptance.md`

Tests:

- `test/unit/chatgpt-plan-auth.test.ts`
- `test/unit/chatgpt-plan-client.test.ts`
- `test/unit/chatgpt-plan-routes.test.ts`
- `test/unit/chatgpt-plan-accounting-config.test.ts`
- `test/unit/background-text-client.test.ts`
- `test/unit/insight-prompt-cache.test.ts`
- `test/unit/project-name.test.ts`
- `test/unit/worker-activity.test.ts`
- `test/unit/worker-report-summary.test.ts`

## Next consent and activation

After the coordinated runtime update, ask the user to consent on their browser
computer using this version's `lattice chatgpt-plan login`, with a separate local
transfer configuration for a remote server. Follow `docs/chatgpt-plan.md` to export
and transfer the owner-only file over SSH, import it into the server's existing
config, preserve the server host ID and let the server own refresh. Never send
tokens through chat or browser storage.

After an authorized runtime update at a safe point, refresh that account's model
catalog in Settings, choose an eligible discovered model and explicitly select
**Test and use ChatGPT plan**. Do not enable dormant generators. Verify the
completed inference and inspect real enabled summaries/labels before claiming
live quality or plan billing. Account eligibility, genuine token renewal,
real output quality and real ChatGPT usage attribution remain unverified.

## Prepared update constraints

The shared release owner coordinates the update only after the benchmark owner
confirms completion. The exact `~/.lattice-restyle/bin/activate-restart.sh` runner
does not wait for quiet and replaces the server-owned daemon. Its `--check-only`
mode still runs `build:web:live` before returning, so it must not be used as a
read-only check while live asset swaps are prohibited.

When separately authorized, the release owner uses the final reviewed, clean HEAD
with `--sha`, an explicit verifier and `--verify-message`. Other intervening local
commits must be included rather than resetting the shared checkout. Leave
`--coordinator-effort` unset unless restoring an explicitly chosen model/effort;
the runner's model default is not this project's required Sol 6.1.

The live launch and `~/.lattice-restyle/bin/lattice` wrapper both run repository
source through `tsx`, pinned to Node 24.14.0 (native ABI 137). The runner rebuilds
the built web client; it does not prepare a distributable CLI for the browser
computer. Build that matching commit in an isolated checkout, with the matching
Node toolchain, then use `pnpm pack:release <outside-repo-output-directory>`.
Root `npm pack`/`pnpm pack` intentionally fails: the release packer must bundle
the built workspace harness. It includes `dist`, shipped banners and postinstall,
not runtime credential directories. Inspect the staged package contents before
securely transferring it; install native dependencies for the browser computer's
own operating system and architecture. Do not publish or use a registry version
that lacks these commands.

Prepare this local CLI and its separate transfer config before offering the user
OAuth. Starting login remains a user-consent step, not part of package preparation.
On the server, the existing wrapper accepts `chatgpt-plan import <protected-file>`
and preserves the live config/host ID. Import leaves routing inactive until the
user chooses a discovered model and completes the explicit setup inference.
