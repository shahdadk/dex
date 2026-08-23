# Dex

Dex is a personal engineering operator that receives instructions by text, delegates work to fresh Claude or Codex workers, preserves useful memory between workers, and can move an in-progress task from a local Mac to a Modal sandbox before putting the Mac to sleep.

The P0 demo has one frozen golden path:

```text
text request
  -> local Claude worker
  -> Claude-Mem handoff snapshot
  -> Codex in Modal
  -> Mac sleeps
  -> deterministic cloud monitor
  -> completion iMessage
```

The defining proof is that the cloud worker uses a fact learned by the local worker, avoids a previously failed approach, and completes while the Mac remains asleep.

## Project status

The architecture is frozen for P0. Implementation priority is:

1. Text ingress and deterministic task control.
2. Fresh local workers and demonstrable memory continuity.
3. Verified Modal handoff and deterministic cloud monitoring.
4. Mac sleep only after cloud continuation is acknowledged.
5. Completion delivery through the existing Sendblue outbox.

Greptile review and remediation are P1 and must not delay the sleep/cloud demo.

## Documentation

- [Architecture and acceptance criteria](docs/architecture.md)
- [Pre-existing infrastructure disclosure](docs/preexisting-infrastructure.md)
