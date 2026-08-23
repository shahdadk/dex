# Pre-existing infrastructure disclosure

## Submission disclosure

Dex was built during the hackathon. It integrates with pre-existing Appfi infrastructure for Sendblue transport, verified-owner identity, durable cloud task storage, Cloud Tasks, and transactional outbound messaging. Dex-specific task orchestration, Claude/Codex worker adapters, Claude-Mem continuity, local machine control, Modal handoff, deterministic Modal monitoring, and Dex UX are implemented as the hackathon project.

## Boundary of reused and new work

| Capability | Provenance | Dex responsibility |
| --- | --- | --- |
| Sendblue inbound and outbound transport | Pre-existing Appfi infrastructure | Consume verified inbound events and enqueue Dex responses |
| Verified-owner identity | Pre-existing Appfi infrastructure | Restrict privileged Dex actions to the verified owner |
| Durable cloud task storage | Pre-existing Appfi infrastructure | Define and maintain Dex task and handoff state |
| Cloud Tasks | Pre-existing Appfi infrastructure | Schedule the deterministic Dex Modal monitor |
| Transactional messaging outbox | Pre-existing Appfi infrastructure | Produce idempotent Dex progress and terminal messages |
| Task routing and orchestration | Hackathon Dex work | Implement deterministic commands, model routing, and task lifecycle |
| Claude and Codex worker adapters | Hackathon Dex work | Start fresh workers locally and in Modal |
| Claude-Mem continuity | Hackathon Dex work | Select, serialize, verify, and demonstrate inherited memory |
| Local machine control | Hackathon Dex work | Gate and execute authorized status and power commands |
| Modal handoff and monitoring | Hackathon Dex work | Package context, launch Codex, reconnect by sandbox ID, and observe completion deterministically |
| Dex user experience | Hackathon Dex work | Present handoff progress and completion clearly by text and in the demo UI |

## Repository presentation

The public submission should link to this disclosure from its README and architecture document. Demo narration should identify Appfi as reused transport and durability infrastructure, then focus technical claims on the Dex-specific orchestration and continuity work.

Do not imply that pre-existing Appfi components were created during the hackathon. Conversely, do not describe Dex as a thin messaging wrapper: the worker lifecycle, memory-complete handoff, sleep gate, cloud execution, and deterministic monitoring are Dex-owned behavior.
