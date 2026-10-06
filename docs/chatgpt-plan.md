# Background inference with your ChatGPT plan

Lattice can use Sign in with ChatGPT for its background text generation. This is
a separate permission from Codex CLI sign-in. It does not read ChatGPT conversations,
change how agent sessions authenticate, or enable dormant generation features.

## Local browser and server

1. Open **Settings → Providers → Use your ChatGPT plan**. Choose **Continue with
   ChatGPT**. From another device, finish with paste-back (below).
2. Complete OpenAI's sign-in and permission screen. Lattice uses an ephemeral
   `http://127.0.0.1:<port>/auth/callback` listener. No public redirect is used.
3. Choose **Refresh models**, select an account-specific discovered model, then
   **Test and use ChatGPT plan**. This sends one small setup request. Routing changes
   only after completed inference and account validation, not merely sign-in.
4. Existing generation opt-ins remain unchanged. In particular, an unset feature
   does not turn on when plan routing is selected. Enable only the features you
   intend to run in `generation` in your config.

The local CLI can also start the browser sign-in:

```sh
lattice-app chatgpt-plan login
lattice-app chatgpt-plan status
lattice-app chatgpt-plan models
```

An installation's `lattice` wrapper accepts the same commands. A saved registration
can be reauthorized with `login --account <issued-client-id>`. The account picker in
Settings keeps registrations separate, including registrations with the same email.
Use `--enable-plan` only when explicitly requesting permission after a prior decline.

## Browser on another device (Tailscale, phone)

A loopback callback reaches the browser's own device, not your server, so it fails
to load there. Settings finishes the sign-in by paste-back instead:

1. Choose **Continue with ChatGPT** and approve on ChatGPT's screen.
2. The ChatGPT tab then shows a page that can't load, at
   `127.0.0.1:<port>/auth/callback?code=…&state=…`. That is expected.
3. Copy that whole address from the address bar and paste it into Settings. Pasting
   finishes the sign-in; **Finish sign-in** is there for an address typed by hand.

If the Lattice page reloads while you are in ChatGPT (iOS often reloads a home-screen
app or a background tab), Settings reopens on the paste step for as long as the sign-in
is still valid. **Reopen it** brings back the ChatGPT tab for the same sign-in.
A button that reads the clipboard for you is not offered: browsers only allow that on
HTTPS or localhost, and a Tailscale IP address is plain HTTP.

The server holds the state, nonce and PKCE verifier for the pending sign-in. It checks
the pasted state, then exchanges the one-time code with the same redirect URI and
verifier, with every check the local callback applies. The pasted address is never
logged. A pending sign-in lasts 10 minutes and does not survive a server restart;
after either, start again. If the browser is on the server itself, the loopback
callback completes the sign-in with no paste.

### Alternative: transfer credentials over SSH

Complete OAuth locally with the same Lattice version, then transfer a protected
credential file over SSH. Do not copy browser storage, use public callbacks, or paste
tokens into chat.

On the browser computer, with a separate temporary Lattice configuration directory:

```sh
export LATTICE_CONFIG_DIR="$HOME/.lattice-plan-transfer"
lattice-app chatgpt-plan login
lattice-app chatgpt-plan export "$HOME/lattice-transfer.chatgpt-credentials.json"
scp "$HOME/lattice-transfer.chatgpt-credentials.json" your-server:~/lattice-transfer.chatgpt-credentials.json
```

`export` writes a new owner-only file and clears the source runtime's tokens **without
revoking the transferred session**. This hands renewal to the destination rather than
letting two computers race the rotating refresh token. It does not activate routing.

On the server, use **that server's existing** `LATTICE_CONFIG_DIR`, not the temporary
laptop directory. The import command creates a stable server host ID if needed and
preserves it when importing; it never replaces it with the laptop ID.

```sh
chmod 600 "$HOME/lattice-transfer.chatgpt-credentials.json"
LATTICE_CONFIG_DIR=/your/existing/lattice-data \
  lattice-app chatgpt-plan import "$HOME/lattice-transfer.chatgpt-credentials.json"
```

Import validates the signed ID/access tokens, client, account, resource, expiry and
grants. Afterwards delete both transfer-file copies securely according to your device
policy. Do not run another source refresh or revoke the transferred session. The
server owns subsequent renewal. In its Settings, check the imported connection,
refresh the model catalog, select a model, and complete **Test and use ChatGPT plan**.

The official self-hosted flow transfers an existing session. Host-specific usage
attribution and revocation for transferred sessions are not currently available.

## Routing, usage and recovery

`backgroundInference` records only the explicit billing route and selected model:

```json
{"backgroundInference":{"provider":"chatgpt-plan","model":"<discovered slug>"}}
```

Credentials are not part of `config.json` or browser responses. Manual config changes
cannot bypass the requirement to test that model on the selected account. Requests
use the public Responses endpoint, complete input/history, `store:false` and
`stream:true`. Unsupported plan parameters, including `temperature` and
`max_output_tokens`, are not sent. Existing summary/mission/name quality guards,
repairs, worker coalescing and stale-activity checks still apply.

Plan token counts are recorded in `chatgpt_plan_usage`, separately from `llm_costs`.
They are **not** API-dollar estimates, an invoice, a remaining allowance, or a claim
that usage is free. API estimates remain in their original ledger. Each completed
request records the actual returned model, not the requested Anthropic model.

At a plan/app usage limit, new plan requests pause. **Manage usage** opens
<https://chatgpt.com/settings/usage>. After reviewing the limit, explicitly choose
**Resume after reviewing usage**. No reset time is guessed. Lattice never enables
credits or silently falls back to a paid API key. Any credits permission in ChatGPT
is controlled by the user there; this protocol does not expose a per-request switch
that overrides it. An explicit **Use Anthropic API billing instead** choice is a
separate billing decision, not error recovery performed behind your back.

**Disconnect** stops local use, attempts renewable-session revocation with bounded
retries, and clears local tokens while retaining the host/client/account mapping.
If remote revocation cannot be confirmed, Settings says so and directs you to
disconnect Lattice in ChatGPT Settings. Temporary errors preserve credentials;
terminal refresh errors clear unusable tokens and require reauthorization.

## Credential protection

The runtime stores `chatgpt-plan/accounts.json` under `LATTICE_CONFIG_DIR`. The
directory is `0700`; atomic credential writes and transfer files are `0600`.
Insecure permissions, foreign ownership, symlinks and malformed credential records
fail explicitly. Tokens and pasted callback addresses
must not appear in logs, diagnostics, commits, packages or support transcripts.

The `accounts.lock` directory serializes refresh and credential mutations across
processes. If a process crashes while holding it, later requests report
`credential_lock_busy`, rather than guessing that a rotating token is safe to reuse.
Stop all processes using that credential directory and inspect it before removing
an abandoned lock. Never remove a lock from an active runtime.

## Acceptance boundary

Mock/source checks prove protocol handling and existing quality contracts; they do
not establish OpenAI account eligibility, live plan billing or real output quality.
Acceptance requires the user's actual consent, account-specific discovery, one
completed setup inference, and inspection of useful real summaries/activity labels
before claiming live success. A connected badge alone is not that evidence.

Protocol references checked September 29, 2026:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

Lattice implements this protocol independently with Node standard libraries. It
does not bundle or copy the Sign in with ChatGPT DevKit.

The unmodified sign-in mark in `public/chatgpt-mark.svg` comes from OpenAI's
official [brand asset pack](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip).
