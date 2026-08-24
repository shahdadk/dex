# Dex

**Text Dex. Get software built.**

Dex is a persistent developer above disposable coding-agent sessions. You give one person an engineering outcome over iMessage; Dex creates durable tasks, runs fresh Codex and Claude workers in isolated Git worktrees, preserves engineering memory, and can continue unfinished work with Codex in Modal.

> **Submission status:** This repository contains a working prototype with automated coverage for the core orchestration contract. Provider-backed features require a configured Dex Cloud deployment, Sendblue line, authenticated local agent CLIs, Claude-Mem, and Modal. The repository does **not** claim that the final physical-sleep-then-completion run has been proven.

## The product

The intended packaged setup contract is one command:

```bash
npx @shahdadk/dex setup --project /absolute/path/to/repository
```

After that, the intended everyday interface is only iMessage:

```text
You: fix checkout with codex
Dex: on it
Dex: i'm starting a fresh codex session for checkout right now

Dex: your mac is at 8% and checkout is still running locally
     want me to move it to the cloud

You: yes
Dex: okay moving checkout to the cloud with codex right now
```

Until the package is published, use the source-checkout commands below. The CLI remains available for setup, diagnostics, recovery, and the controlled battery demonstration; it is not the normal product UI.

## The 60-second demo

The submission video tells one focused story:

1. One short iMessage creates a durable checkout task and starts a fresh Codex worker locally.
2. Dex responds immediately while the worker starts, so the user never manages a terminal session.
3. A clearly labeled controlled 8% reading enters the same battery-policy function used by real macOS telemetry.
4. The user answers once. Dex checkpoints the branch and packages code, tests, task state, selected Claude-Mem observations, and known failed approaches.
5. Fresh Codex starts in Modal with that continuity package. The worker changed; the task did not.
6. The video closes on the product thesis: **The agents are disposable. Dex isn't.**

Claude-Mem and Modal are part of the demonstrated architecture. Greptile is not presented as part of the working P0 path; it remains an optional post-completion review integration.

## How it works

```text
                          iMessage
                              │
                              ▼
                         Dex Cloud
                verified owner · durable task
                              │
                              ▼
                       Dex on the Mac
                  ┌───────────┴───────────┐
                  ▼                       ▼
             Codex / local          Claude / local
                  │                       │
                  └──────────┬────────────┘
                             ▼
                 task state + Claude-Mem
                             │
                   signed Git handoff
                             │
                             ▼
                       Codex / Modal
                             │
                 deterministic cloud monitor
                             │
                             ▼
                    completion via iMessage
```

The durable object is the task, not an agent session. Each task owns its intent, repository, Dex branch, worktree, summaries, discoveries, test state, failed approaches, and worker history. Claude and Codex sessions can end or change without changing task identity.

## Implemented surfaces

| Area | Repository behavior |
| --- | --- |
| Messaging | Sendblue webhook verification, owner/conversation binding, signed device commands, replay protection, deduplication, and transactional completion contracts |
| Routing | Deterministic control routes plus schema-validated Gemini routes; natural language never becomes shell input |
| Tasks | Durable state machine, isolated branches/worktrees, two-worker scheduling, semantic status, cancellation, agent changes, and restart recovery |
| Workers | Fresh Codex and Claude CLI adapters with JSON event normalization, provider session IDs, cancellation, timeouts, and scoped environments |
| Memory | Claude-Mem observation/retrieval path plus deterministic `TaskKnowledge` fallback; failed approaches are first-class handoff data |
| Cloud | Signed Git bundle and handoff, direct Modal upload, fresh cloud Codex, deterministic monitor, retained result artifact, and validated local result import |
| Machine | Real `pmset` battery parsing, explicit simulated readings, owner-scoped follow-up prompts, `caffeinate`, restore behavior, and a deterministic sleep gate |
| Diagnostics | `doctor`, `status`, `watch`, cloud smoke check, memory fixture, battery fixture, and power restore |

Session transcript discovery and validated adoption requests are present, but the end-to-end conversational adoption flow is not part of the P0 demo. Greptile review is P1.

## Decision policy

Dex applies the least-powerful path that can safely interpret a message:

| Message class | Route | Thinking |
| --- | --- | --- |
| Status, memory, task control, agent, location, and power commands | Deterministic code | None |
| Ordinary task creation and simple extraction | `gemini-3.5-flash-lite` | `minimal` |
| Ambiguous or context-dependent decomposition | `gemini-3.7-flash` | `low` |

Every model result must validate as a typed `DexAction[]`. Only known implementation functions can create tasks, move work, or control power.

## Continuity and cloud handoff

Before local work moves to Modal, Dex:

1. checkpoints the Dex task branch;
2. creates a reconstructable Git bundle;
3. selects relevant Claude-Mem observations and deterministic task knowledge;
4. includes decisions, failures, changed files, tests, blockers, and next steps;
5. redacts and scans the package for secrets;
6. hashes the artifacts and signs the handoff; and
7. confirms fresh Codex started with the expected task and handoff identities.

Cloud continuation never depends on the local Claude-Mem service after upload. The deterministic monitor reconnects by Modal sandbox ID, validates the result, schedules one terminal effect, and retains enough metadata for the local daemon to verify and import `result.bundle` safely.

## Battery and sleep safety

Real readings come from `/usr/bin/pmset -g batt`. The internal demo command sends `simulated: true` through the same policy function and keeps that provenance in events, `dex watch`, and user-facing copy.

Dex does not silently disable system sleep or install a privileged helper. Normal keep-awake uses `caffeinate`. A sleep request is executed only after a final deterministic cloud-ownership check; if the check or `pmset sleepnow` fails, Dex reports that the Mac remains awake.

The source and tests implement this gate. A real physical sleep followed by completion while the Mac remains asleep is an external rehearsal, not a claim made by this repository.

## Run from source

Requirements:

- macOS for the local daemon and power integration
- Node.js 22+
- Git
- authenticated `codex` and `claude` CLIs
- a reachable Claude-Mem worker for semantic memory (task knowledge remains available as fallback)
- Modal authentication for cloud continuation
- configured Dex Cloud and Sendblue credentials for iMessage delivery

```bash
git clone https://github.com/shahdadk/dex.git
cd dex
npm ci
npm run build
npm exec -- dex setup --project /absolute/path/to/repository
```

Configuration names and secret boundaries are documented in [`.env.example`](.env.example). Dex does not automatically load that file.

## Internal diagnostics

```bash
npm exec -- dex doctor
npm exec -- dex status
npm exec -- dex watch --once
npm exec -- dex route "status?"
npm exec -- dex cloud doctor
npm exec -- dex demo battery 8
npm exec -- dex power restore
```

`cloud doctor` creates and terminates a real Modal sandbox. `demo battery` is an explicitly simulated input and may notify the owner only when the normal active-task policy conditions are met.

## Verify

CI uses Node 22 and runs the same local quality gates:

```bash
npm ci
npm run typecheck
npm run build
npm test -- --maxWorkers=1 --no-file-parallelism
npm audit --omit=dev
git diff --check
```

The suite includes focused unit and integration tests plus a composed golden-path acceptance using controlled provider boundaries. Temporary Git repositories, worktrees, bundles, cryptographic verification, persistence, subprocess handling, result import, and package installation are exercised directly. Credentialed services and physical macOS sleep are intentionally not inferred from those tests.

See [the architecture document](docs/architecture.md) for lifecycle, trust boundaries, and the evidence matrix.

## Scope and provenance

Dex owns the typed orchestration, durable task lifecycle, agent adapters, memory packaging, local machine policy, Modal handoff/monitor/import path, and product experience in this repository. It integrates with existing cloud messaging, verified-owner identity, durable scheduling/storage, and transactional outbound-delivery boundaries. Those service boundaries are dependencies, not work claimed as new Dex infrastructure.

Not in P0: automatic pushing or merging, deployment, a web dashboard, aggressive closed-lid sleep prevention, generalized multi-agent infrastructure, or mandatory Greptile review.
