# Dex review rules

Read `docs/architecture.md` before evaluating a change. Treat its product boundary,
runtime responsibility map, deterministic gates, and safety constraints as the source
of truth.

## Safety and authority

- Fail closed at authentication, owner identity, repository identity, signature,
  handoff, power, and result-validation boundaries.
- Keep model output and external provider content untrusted until schema validation
  and deterministic authorization have completed.
- Never introduce autonomous push, pull-request creation, merge, deployment,
  permission bypass, or credential propagation.
- Redact secrets before persistence, logs, errors, messages, or remediation input.

## External effects

- Require stable idempotency keys for retryable side effects.
- Treat network failures after a write begins as ambiguous. Reconcile or stop; never
  blindly repeat a write that may already have committed.
- Bound polling, response sizes, retries, backoff, output size, and cleanup behavior.
- Preserve exactly-once terminal effects and owner-checked state transitions.

## Change quality

- Preserve typed interfaces and strict runtime validation at trust boundaries.
- Add focused tests for success, malformed input, timeout/abort, deduplication, and
  redaction behavior when those paths change.
- Keep optional integrations inert until an explicit caller invokes them.
