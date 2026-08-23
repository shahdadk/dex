# Dex architecture

**Status:** Frozen for P0 implementation

**Primary demo:** A task starts with Claude on a Mac, continues with Codex in Modal after the Mac sleeps, and reports completion by iMessage while the Mac remains asleep.

## Product boundary

Dex owns task orchestration, worker adapters, memory continuity, local machine control, Modal handoff, deterministic completion monitoring, and the user-facing Dex experience. It reuses existing Appfi infrastructure for messaging transport, verified-owner identity, durable cloud task storage, Cloud Tasks, and transactional outbound delivery. See [Pre-existing infrastructure](preexisting-infrastructure.md).

## Authoritative execution policy

Use deterministic code whenever the intent maps to an exact operation. Use Gemini only when language interpretation or planning is required.

| Work | Executor | Thinking level |
| --- | --- | --- |
| Exact `status`, task control, and power commands | Deterministic code | No model call |
| Fast Lane classification and simple structured extraction | `gemini-3.5-flash-lite` | `minimal` |
| Ambiguous routing, task decomposition, and planning | `gemini-3.7-flash` | `low` |

This policy applies across the relevant Appfi, AI Employee, and Dex paths. Remove active `gemini-3.6-flash` references from those paths; do not preserve conflicting model settings.

Model output never directly executes a power command. It may produce a typed intent, but deterministic authorization and command handlers perform the action.

## System flow

```text
Sendblue inbound message
          |
          v
Appfi webhook + verified-owner identity
          |
          v
Dex deterministic command gate
          |
          +-- exact command ----------> task/status/power handler
          |
          +-- Fast Lane --------------> Gemini 3.5 Flash-Lite (minimal)
          |
          +-- ambiguous work ---------> Gemini 3.7 Flash (low)
                                             |
                                             v
                                    local Claude worker
                                             |
                                  Claude-Mem search/snapshot
                                             |
                                             v
                                signed/hashed handoff.json
                                             |
                                      verified upload
                                             |
                                             v
                                      Codex in Modal
                                             |
                                sandbox ID + handoff ACK
                                             |
                           Mac may sleep only after this point
                                             |
                                             v
                              Cloud Tasks Dex monitor
                                             |
                                 durable task + outbox
                                             |
                                             v
                                  Sendblue completion
```

## Deterministic Modal monitoring

Cloud Tasks schedules a deterministic Dex Modal-monitor job. Monitoring sandbox completion must not require Gemini or any other model.

```text
Codex / Modal
      |
      v
  sandbox ID
      |
      v
 Cloud Tasks
      |
      v
Dex Modal Monitor
      |
   complete?
   /      \
 no       yes
 |         |
reschedule read and verify result artifacts
           |
           v
     update durable task
           |
           v
     Sendblue outbox
```

The monitor must:

1. Receive a durable Dex task ID and Modal sandbox ID.
2. Reconnect to the sandbox by ID and observe process state.
3. If work is still running, record liveness and schedule another monitor attempt with bounded backoff.
4. If work has ended, read and validate the result artifact before changing task state.
5. Update the durable task idempotently and enqueue exactly one terminal Sendblue message.
6. Record terminal failures, timeouts, and missing or malformed result artifacts without inventing a successful result.

Cloud Tasks delivery is at-least-once, so each monitor invocation and terminal transition must be safe to repeat. A task-level completion key must prevent duplicate completion messages.

### Result artifact contract

The cloud worker writes a machine-readable terminal artifact containing at least:

```json
{
  "taskId": "dex_task_id",
  "handoffSha256": "sha256-of-handoff",
  "status": "succeeded",
  "summary": "What changed and why",
  "validation": {
    "commands": ["test command"],
    "passed": true
  },
  "git": {
    "branch": "dex/task-name",
    "commit": "commit-sha"
  }
}
```

Allowed terminal states are `succeeded`, `failed`, and `cancelled`. The monitor treats any other state as non-terminal or malformed according to the artifact schema.

## Memory-complete cloud handoff

Cloud continuation must not depend on the local Claude-Mem service after handoff. All memory required to continue the current task is materialized into the handoff package before sleep.

```text
Claude/local
     |
Claude-Mem search
     |
select 5-15 relevant memories
     |
write memories into handoff.json
     |
upload to Modal and verify hash
     |
Codex acknowledges the same hash
     |
only then may the Mac sleep
```

`handoff.json` must include:

- Task goal, constraints, and acceptance criteria.
- Repository URL, base commit, working branch, and the checkpoint needed to reconstruct local work.
- Five to fifteen selected memories relevant to the current task.
- Learned facts, attempted approaches, and explicit reasons failed approaches should not be repeated.
- Validation commands and the expected evidence of success.
- A handoff version, creation timestamp, task ID, content hash, and integrity metadata.

The package must be content-addressed with SHA-256. Sign the hash with an HMAC when the handoff crosses the local-to-cloud trust boundary, and verify that signature before launching the worker. Signing keys and cloud credentials must not be embedded in the handoff; inject them separately through the runtime secret mechanism.

Before sleep, Dex must:

1. Finish the local git checkpoint.
2. Query Claude-Mem and select the continuation context.
3. Serialize the complete handoff and compute its SHA-256 hash.
4. Upload the handoff to Modal and read it back or otherwise verify the uploaded hash.
5. Start Codex and receive a startup acknowledgement containing the same task ID and handoff hash plus the IDs of the parsed memories and failed approaches loaded into worker context.
6. Persist the sandbox ID and enqueue the first monitor job.
7. Tell the user that cloud continuation is active.
8. Invoke the deterministic sleep command.

Any failure before step 6 keeps the Mac awake and returns an actionable error.

## P0 acceptance criteria

The P0 path is complete only when all of the following work end to end:

- A verified owner can send a natural-language task through Sendblue.
- Exact status, task-control, and sleep commands use deterministic handlers.
- Dex starts a fresh local worker for the task.
- Relevant Claude-Mem observations are selected and embedded in the cloud handoff.
- A fresh Codex worker demonstrably uses a fact learned by the previous worker and avoids repeating a known failed approach.
- The Modal upload, handoff integrity verification, context-aware worker acknowledgement, sandbox ID, and monitor scheduling are durably recorded before sleep.
- The Mac actually sleeps while the Modal sandbox continues.
- The deterministic monitor observes completion without a model call.
- The durable task reaches the correct terminal state exactly once.
- A completion iMessage reaches the user's phone while the Mac remains asleep.

The memory criterion requires behavioral evidence, not merely a memory count. The demo artifact or worker log must identify the inherited fact, the rejected failed approach, and the action Codex took because of that context.

## Demo script

1. The user texts: `dex, investigate checkout`.
2. Dex starts Claude locally.
3. Dex reports: `your Mac is at 8%. checkout is still running. move it to the cloud?`
4. The user replies: `yes, use codex and sleep my mac`.
5. The projector shows:

   ```text
   CHECKPOINT
   ✓ git state

   MEMORY
   ✓ 11 observations

   HANDOFF
   Claude/local -> Codex/Modal

   CLOUD
   ✓ Codex started
   ✓ monitoring transferred
   ```

6. Dex confirms: `checkout is running in the cloud. sleeping this mac now.`
7. The Mac sleeps and stays asleep.
8. The phone receives a concise completion with the cause, fix, and validation result.

The display must only show successful handoff steps after each corresponding durable acknowledgement has been received.

## P1: Greptile verification loop

Greptile is intentionally excluded from P0. After the sleep/cloud path is reliable, Dex may add this verification loop:

```text
Codex finishes
      |
tests pass
      |
PR opened or updated
      |
Greptile review
      |
 material finding?
   /          \
 no           yes
 |             |
done      structured feedback
                |
                v
       fresh Codex remediation
```

Requirements:

- Trigger Greptile only after Codex validation passes and a reviewable branch or PR exists.
- Convert material findings into structured Dex task feedback with the PR, file, location, severity, and recommendation.
- A remediation attempt starts a fresh Codex worker with the original handoff plus the new finding.
- Cap automatic remediation attempts to prevent review loops.
- Greptile latency, failure, or absence must never block P0 task completion or the core demo.

## P0 non-goals

- Greptile review or autonomous review/fix loops.
- General multi-agent swarms.
- Replacing the existing Appfi transport, identity, task store, or messaging outbox.
- Model-based polling or model-generated interpretations of process completion.
- Cloud access to the live local Claude-Mem service after sleep.
- Additional architecture changes before the golden path is working.

## Implementation order

1. Text ingress and exact deterministic commands.
2. Fresh local Claude and Codex worker adapters.
3. Claude-Mem selection plus a behavioral continuity test.
4. Versioned `handoff.json`, hashing, upload verification, and startup acknowledgement.
5. Modal execution and result artifact contract.
6. Deterministic Cloud Tasks monitor and idempotent Sendblue completion.
7. Real Mac sleep end-to-end test.
8. P1 Greptile integration only after P0 passes repeatedly.

## External references

- [Gemini thinking levels](https://ai.google.dev/gemini-api/docs/thinking)
- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Modal sandbox lifecycle and reconnecting by ID](https://modal.com/docs/guide/sandboxes)
- [Modal JavaScript Sandbox SDK](https://modal.com/docs/sdk/js/latest/Sandbox)
- [Sendblue webhooks and outbound status events](https://docs.sendblue.com/getting-started/webhooks/)
- [Greptile GitHub integration](https://www.greptile.com/docs/integrations/github-gitlab-integration)
