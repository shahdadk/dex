# Dex

**Text Dex. Get software built.**

Dex is a personal engineering operator for iMessage. Send it a task, let a fresh Claude or Codex worker handle the repository, ask what is running, and move unfinished work from your Mac to Codex in Modal when the machine needs to sleep.

Dex is designed around one product promise: after a one-time setup in Terminal, the everyday interface is iMessage.

> **Implementation status:** Dex Cloud and the paired Mac daemon are live. Real Sendblue pairing and messaging, concurrent fresh Codex/Claude workers, Claude-Mem retrieval, the production battery-policy path, ChatGPT-account-backed Codex in Modal, and local-to-cloud handoff have all run successfully. The release monitor has also collected a result from a real detached Modal sandbox before terminating it. Physical sleep remains an explicit final demo action and is not claimed as completed here.

## Set up once

Dex requires macOS, a Git repository, Node.js 22 or newer, and authenticated `claude` and `codex` CLIs on `PATH`.

The release setup is one command:

```bash
npx @shahdadk/dex setup --project /absolute/path/to/your/repository
```

Setup checks the machine and agent CLIs, shows one `PAIR …` text to send from the owner's phone, stores the device identity in macOS Keychain, registers the default repository, and runs a real Modal create/execute/detach/reconnect smoke test. It then writes Dex state under `~/.dex` by default and installs a background LaunchAgent. When it finishes, close Terminal and text Dex.

The package metadata and setup command exist in this repository. Registry publication and live cloud pairing are external release steps and are not established by the automated tests here.

### Setup environment

The full local and cloud configuration is listed in [`.env.example`](.env.example). Dex does not automatically load a `.env` file; provide values through the setup environment or the deployment secret system.

| Name | Purpose | Needed for |
| --- | --- | --- |
| `DEX_CLOUD_URL` | Dex Cloud service URL | Pairing, iMessage command sync, and cloud events |
| `DEX_DEVICE_ID` | Paired Dex device identity | Normally written by setup; may override runtime config |
| `DEX_DEVICE_KEY_ID` | Device signing-key identifier | Normally written by setup; may override runtime config |
| `DEX_CLOUD_SERVER_KEYS_JSON` | JSON array of pinned Dex Cloud Ed25519 public keys | Required for setup and signed-command verification |
| `DEX_SENDBLUE_LINE` or `SENDBLUE_NUMBER` | Dex's iMessage phone number | Required so setup can show where to send `PAIR …`; the second name is a compatibility alias |
| `GEMINI_API_KEY` | Gemini router credential | Model-assisted natural-language routing; deterministic routes still work without it |
| `MODAL_TOKEN_ID` | Modal account token ID | Optional locally when an authenticated `~/.modal.toml` profile exists; required for headless cloud monitoring |
| `MODAL_TOKEN_SECRET` | Modal account token secret | Optional locally when an authenticated `~/.modal.toml` profile exists; required for headless cloud monitoring |
| `DEX_MODAL_SECRET_NAME` | Name of the Modal secret attached to cloud workers | Optional; defaults to `dex-workers` |
| `DEX_MODAL_CODEX_AUTH_VOLUME` | Private Modal Volume containing a ChatGPT-backed `auth.json` | Preferred for cloud Codex; mount is used as persistent `CODEX_HOME` |
| `CODEX_API_KEY` | Scoped Codex automation credential | Optional API-billed alternative to account auth |
| `DEX_HANDOFF_SIGNING_KEY` | HMAC key for local-to-cloud handoff integrity | Required for cloud continuation; keep secret |
| `DEX_HOME` | Override for Dex's local data directory | Optional; defaults to `~/.dex` |
| `CLAUDE_MEM_URL` | Claude-Mem health endpoint override used by diagnostics | Optional; defaults to the local service |
| `DEX_DEFAULT_REPOSITORY` | Default Git repository path | Optional runtime override |

The cloud runtime also accepts the existing `SENDBLUE_API_SECRET` and `SENDBLUE_WEBHOOK_SECRET` names as aliases for Dex's canonical names. This lets a deployment reference the same managed secrets without copying their values.

Setup stores Dex runtime credentials in macOS Keychain and the LaunchAgent hydrates them at startup. Modal may authenticate locally through its active `~/.modal.toml` profile; headless Dex Cloud receives the same API-token pair through its deployment secret boundary. By default, cloud Codex uses the user's ChatGPT-backed login from a private persistent Modal Volume; `CODEX_API_KEY` remains an optional automation fallback. The spawned coding process cannot see Modal control credentials or the signing key after verification.

## The iMessage experience

After setup, there is no routine CLI workflow. Text requests and control messages to the paired Dex conversation:

```text
You: Dex, investigate checkout failures
Dex: on it. i'm working on checkout failures.

You: status?
Dex: 1 thing active:

     checkout failures — investigating the issue

     nothing needs you right now.

You: move checkout failures to the cloud and use codex,
     then sleep my mac
Dex: checkout failures is being handed to codex in the cloud.

     i'll sleep this mac once cloud ownership is confirmed.
```

Dex also understands task controls such as `stop checkout failures`, `resume checkout failures`, `keep my mac awake until everything is done`, and `use claude for checkout failures`.

## Golden path

The acceptance path is deliberately narrow and exact:

1. The verified owner texts `Dex, investigate checkout failures` by iMessage.
2. Dex creates an isolated task worktree and starts a fresh local Claude worker.
3. Dex records durable task progress and useful observations. Claude-Mem is preferred when available; task-scoped knowledge is the fallback.
4. A real low-battery reading can prompt the owner to keep the Mac awake or move work. A controlled demo reading must say `(demo reading)` and must never be presented as real telemetry.
5. The owner replies `move checkout failures to the cloud and use codex, then sleep my mac`.
6. Dex checkpoints the Git state, selects 5–15 memories, includes learned facts and failed approaches, redacts secrets, and signs the handoff.
7. Dex uploads the Git bundle, handoff, and worker to a Node 22 Modal sandbox.
8. Codex starts in Modal and acknowledges the task ID, exact handoff hash, loaded memory IDs, and loaded failed-approach IDs.
9. Only after that acknowledgement is durable and cloud monitoring is scheduled may Dex release its keep-awake assertion and request macOS sleep.
10. A deterministic monitor reconnects by Modal sandbox ID, validates the terminal result, and asks the existing cloud outbox to deliver exactly one completion iMessage while the Mac remains asleep.

The defining continuity proof is behavioral: the cloud worker uses a fact learned locally and avoids a recorded failed approach. A memory count alone is not proof.

## How Dex makes decisions

Exact control language stays deterministic. Model output is only allowed to become a validated, typed Dex action; it never becomes a shell or power command.

| Message class | Route | Thinking |
| --- | --- | --- |
| Exact status, memory, task-control, agent, location, and power requests | Deterministic handlers | No model call |
| Normal natural-language task routing | Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) | `minimal` |
| Ambiguous or context-dependent routing | Gemini 3.7 Flash (`gemini-3.7-flash`) | `low` |

If Gemini is unavailable, Dex falls back to deterministic task creation rather than giving a model control over an exact action.

## Continuity across local and cloud work

Dex launches fresh workers instead of treating an agent process as permanent. Continuity lives in durable state and a self-contained handoff:

- A task has its own `dex/...` branch and worktree.
- Claude-Mem observations are searched and ranked with task knowledge as a fallback.
- The handoff contains the goal, constraints, acceptance criteria, repository checkpoint, validation commands, learned facts, and failed approaches.
- The Git bundle and handoff content are hashed; the manifest is HMAC-signed for the cloud boundary.
- The Modal worker verifies the package before starting Codex and cannot depend on the Mac's live Claude-Mem service after upload.
- The current P0 path is local-to-cloud only. Returning a cloud commit to the local worktree is not implemented, so Dex must not claim bidirectional synchronization yet.

## Battery readings: real and demo

Real telemetry comes from `/usr/bin/pmset -g batt` and is marked `simulated: false`. The internal demo command injects a controlled reading through the same alert policy and marks it `simulated: true`; both the event and user-facing copy preserve that distinction.

The parsing, policy, and disclosure behavior are covered by automated tests, and the daemon starts real background polling. The internal demo command sends a simulated reading over Dex's owner-only local control socket; an eligible alert can follow the same cloud notification bridge but retains `(demo reading)` in its copy. This is not evidence of real battery telemetry or live iMessage delivery.

## Security boundaries

- The cloud messaging client accepts commands only when the schema, pinned server signature, verified-owner authority, owner identity, and expiry checks pass.
- Device requests use canonical body hashes, Ed25519 signatures, monotonic sequence numbers, nonces, and timestamps. Non-loopback cloud URLs must use HTTPS, and device private keys are designed for macOS Keychain storage.
- Handoff creation redacts known secret forms and fails closed if a secret remains. Credentials are injected separately at runtime.
- Local and cloud coding workers receive provider-scoped environments; unrelated Gemini, Modal, Sendblue, and handoff-signing credentials are stripped.
- Codex runs with a workspace-write sandbox, no interactive approvals, and unsafe bypass flags blocked. Workers are instructed not to push, deploy, merge, or change protected branches.
- Sleep is a deterministic command gated immediately before `pmset sleepnow`; a model cannot invoke it directly. Dex uses no `sudo` for battery or sleep commands.
- The monitor uses retry and terminal idempotency keys. A production deployment must enforce them in the durable task/outbox transaction so retries cannot create duplicate completion messages.

See [Architecture](docs/architecture.md) for the trust boundaries, state transitions, handoff contract, and current integration gaps.

## Verification status

The complete local verification passes:

```bash
npm run typecheck
npm test -- --run
npm run build
```

The current suite has **135 passing tests across 21 files**. It includes one composed golden-path acceptance that crosses signed Sendblue ingress, pairing and device sync, concurrent fresh Codex/Claude workers, semantic status, memory and failed-approach continuity, the production battery-policy function, Modal startup acknowledgement, deterministic cloud monitoring, the sleep gate, and exactly-once Sendblue completion. External provider boundaries in that acceptance use controlled fakes; cryptography, Git worktrees/bundles, subprocesses, persistence, and package installation are real.

Additional safe live checks completed on this Mac:

- Gemini 3.5 Flash-Lite with `minimal` and Gemini 3.7 Flash with `low` both returned valid structured routes;
- a real Claude-Mem observation was written, summarized, searched, and fetched back as observation `#5873`;
- authenticated local Codex and Claude adapters each completed a disposable Git-fixture edit; and
- two fresh Modal sandboxes accepted the persistent ChatGPT-backed Codex login with both API-key variables blank;
- a live iMessage created concurrent fresh Codex and Claude workers in isolated worktrees;
- a controlled 8% reading produced the real low-battery policy event and Sendblue alert;
- a live Claude task was checkpointed with 13 continuity items and started fresh Codex in Modal; and
- the release monitor collected and durably accepted a result from real detached sandbox `sb-3NcmwQhUtX31ZZprmIohOn` before termination.

The following final-stage proofs remain before claiming the physical sleep demo is complete:

- one full post-fix coding-worker completion delivered exactly once through Sendblue; and
- a real Mac sleep after cloud ownership is confirmed, followed by completion while the Mac remains asleep.

## After the golden path

P1 is intentionally non-blocking: automatic worker replacement, full daemon-restart recovery, old-session adoption, three-task concurrency, cross-agent review, and a Greptile verification loop. In that loop, a passing Codex branch may be reviewed by Greptile; a material finding becomes structured Dex feedback for one bounded fresh Codex remediation attempt. Greptile can never delay P0 completion.

## Internal diagnostics

These commands are for contributors and operators, not the everyday Dex UX:

```bash
npm exec -- dex doctor
npm exec -- dex status
npm exec -- dex watch --once
npm exec -- dex route "status?"
npm exec -- dex cloud doctor
npm exec -- dex demo battery 8
npm exec -- dex power restore
```

`cloud doctor` creates, detaches from, reconnects to, and terminates a real Modal sandbox, so run it only with authorized credentials. `demo battery` is simulated, requires the background daemon, and can enqueue a clearly demo-labeled alert when the battery policy's task conditions are met.

## Provenance

Dex owns the orchestration, typed routing, agent lifecycle, memory packaging, local power policy, Modal handoff, deterministic monitor, and Dex user experience in this repository. It deliberately uses existing cloud messaging and task-service boundaries for iMessage transport, verified-owner identity, durable scheduling/state, and transactional outbound delivery. Those service boundaries are dependencies, not work claimed as new Dex implementation.
