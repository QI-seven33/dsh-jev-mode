# 0.4.4 (2026-10-17)

- Close out as a reliability-only release. Retain the 0.4.3 settings UI; do not ship the experimental JSON transaction plugin or introduce new JEV involvement in everyday tasks. Rewrite both READMEs around shipped behavior, data flow, installation and known limits, with smaller, collapsed UI previews.
- Fit HTTP retry waits within the existing decision deadline. Honor server Retry-After seconds/HTTP-date and retry-after-ms without the old five-second truncation; stop promptly when a retry cannot fit. Add jitter only to local backoff.
- Share explicit 429/503 cooldown within each HTTP engine instance. Following calls return unavailable without another HTTP request; skipped calls do not add provider-health failures or strand half-open probes. Authorization still asks/denies.
- Bound the sending stage's second credential lookup and consume late completion without sending a request. Contain synchronous startup lookup failures as well as asynchronous ones.
- Record numeric HTTP request/retry/wait/skip counts in metadata-only ledger rows, including degraded decisions. Cache hits report zero new HTTP work.
- Add 14 transport regressions, native rate-limit ask/deny write checks, and an immutable-v0.4.3 loopback fault comparison. Three synthetic live calls to pinned jev-1.13.0 succeeded; no end-to-end speed or safety-accuracy claim.
- Fix auxiliary model requests freezing AbortSignal, which broke native DeepSeek signal composition. Request data remains immutable; cancellation capabilities remain live.
- Verify native DeepSeek thinking signatures/history, request-local auxiliary thinking-off, SSE keep-alives and V4 reasoning persistence. Add content-free reasoning/latency benchmark counters and bounded live-run controls; correct the hardcoded benchmark report version.
- Four small live DeepSeek task executions passed (eight main-model requests, zero JEV requests). This is a limited deterministic-read smoke, not new general performance evidence. See reports/2026-10-17-deepseek.zh.md.
- Main-model static prompt/tool schemas, authorization thresholds, model defaults and native permission ownership are unchanged. See reports/2026-10-17-transport-budget.zh.md for the earlier candidate and measurement limits.

# 0.4.3 (2026-10-17)

- Match the native Models provider-row padding, title typography, status dot and compact Edit control. Browser comparisons cover 100/125/150/200 percent zoom and host theme tokens; credential-modal behavior is retained.
- Reject malformed Noul probabilities instead of coercing/clamping them into authorization decisions. Failed responses escalate or deny and cannot enter the advisory cache.
- Reserve one half-open circuit-breaker probe during recovery.
- Remove cancelled/expired decisions from the concurrency queue before calling the provider; pass the existing decision deadline to that queue.
- Prevent an asynchronous credential lookup failure from becoming an unhandled startup rejection.
- Isolate user cancellation and queued expiry from provider-health failures; release abandoned half-open probes without clearing failure history. Credential lookup now shares the decision deadline.
- Bind automatic approvals to the current human history, execution arguments/call and working directory. Revalidate after decision/ledger waits and downstream permission checks; stale approvals ask/deny, cancelled executions stop.
- Add 12 focused hardening tests plus native-host allowed-write, in-flight/downstream revocation and cancellation regressions.
- Authorization thresholds, prompt sections, tool catalog and ordinary-task JEV coverage are unchanged. No new live end-to-end performance claim. No new feature, model migration or cache-policy rewrite is included.

# 0.4.2

- Collapse the JEV Models card to a provider row; Edit opens the host Modal with write-only credential controls. Closing clears unsaved input.
- Verify packaged installation in a fresh isolated profile and document public installation requirements.

# 0.4.1

- Add a JEV credential card to the native Models settings footer. Uses host write-only credentials operations; no secret readback, browser persistence, chat-model adapter or connectivity claim.
- Separate the global settings anchor from the preset-only mode entry. Decision control flow, static prompt and tool schemas are unchanged.

# 0.4.0 acceptance candidate

Deterministic-first reads; optional bounded contrastive semantic selection; focused static protocol; version/selection/fallback/reuse counters; fail-open gate configuration removed. Authorization cuts and native permission ownership are retained. See REPAIR-0.4.0.md.

# 0.3.0 — 2026-10-02

Classify file effects/paths instead of document bodies, extract patch targets,
and distinguish narrow literal-output/read-only commands conservatively.
Unify all authorization entry points on host-owned human history; authorize
questions cannot be replaced by caller instructions. Keep 0.85/0.55 cuts.
Add opt-in controlled fixed reads selected by real JEV: no generated arguments,
native tools.execute guards, attributed V4-persisted result notice and fallback.
The preset enables controlledFlow and disables always-on advisory autoRoute.
Reuse complete visible unchanged read evidence without another decision/read;
file changes, projected/pruned history and explicit refresh invalidate reuse.
Keep all three public schemas fixed; internal dispatch is not a public tool.
The deployment's static guidance changes once and needs a new prefix warm-up.
Add native guarded-read/denial/persistence/prefix regressions and a real official
SDK standard-vs-JEV benchmark with repeated, interleaved, objectively graded tasks.
No universal speed, accuracy or 99.8% cache guarantee is made.

# 0.2.1 — 2026-10-02

Fix automatic routing notices rejected by the native V4 session writer: emit
`source.kind: 'plugin:dsh-jev-mode'` instead of the retired plugin wrapper.
Keep the model-visible notice text, fixed system prompt and tool catalog unchanged.
Add a native codec regression and real JSONL/Zstandard write, cold-read and
resumed-turn tests. In-memory boot checks alone do not cover this boundary.

# 0.2.0 — 2026-10-01

Repair the desktop preset: real TypeSafe credential references, automatic routing notices, complete advisory cache keys, uncached authorization, metadata-only optional ledger, submitted human question answers, counted gate budgets and fail-closed escalation. Keep prompt text and tool schemas static; append route advice through the native pre-step seam. Fix outside-path/root-delete classification, invalid-response caching and reasoning fallback. Add 17 regressions and real-host/live-endpoint smoke evidence. End-to-end speed and accuracy gains are not claimed.

Earlier entries below describe historical versions; current behavior is in README.md and REPAIR-0.2.0.md.

# Changelog

All notable changes to this bundle. This project follows [Semantic
Versioning](https://semver.org/spec/v2.0.0.html) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Because the bundle inserts an agent preset, a change to `cordis.patch.yml`
changes the mode's **prompt prefix and tool catalog**, which is exactly what
provider prefix caching depends on. Any such change is listed under `Changed`
with an explicit note, and the `RUBRIC_VERSION` in `lib/gate.js` is bumped
whenever decision wording or thresholds move, which invalidates cached verdicts.

## [Unreleased]

### Changed
- **`backend: auto` now prefers a configured TypeSafe JEV backend.** Configuring a
  key is an explicit opt-in, and it buys what the other route cannot: TypeSafe's
  System One model returns *calibrated* probabilities, whereas the `model` route is
  this harness asking its own generative model to emit a number. With no key, `auto`
  behaves exactly as before — the session route, no credential needed. An explicitly
  pinned backend keeps the others as fallbacks, logs a warning when its key is
  missing, and the ledger records the engine that actually answered, so a fallback
  is auditable rather than silent.

### Verified against the live service
- The `typesafe` transport was exercised against
  `POST https://api.typesafe.ai/v1/systemone` (model `jev-1.13.0`) through **this
  bundle's own code**: `engine.available()` true, the pipeline selecting `typesafe`,
  and three real decisions parsed and banded correctly. The live model discriminated
  between an unrequested destructive target (`noul 0.02` → deny) and the target the
  user actually named (`noul 0.57` → ask), and returned `score 2.45` with
  `probabilities {2: 0.49, 3: 0.48}` for a force-push, which the `score` normalizer
  read as level 2 from the **distribution peak** rather than from the mean.
- The `risk` channel's four level descriptions came back verbatim in the response
  `legend`, which is evidence the criteria wording is read as written.
- Those three live response shapes are now fixtures in `test/transport.test.mjs`,
  because the service differs from this bundle's own rubric in ways that are easy to
  assume away: a `noul` answer carries **neither `confidence` nor `basis`**, and a
  `score` answer carries a `legend`.
- `test/transport.test.mjs` grew to 33 checks, with backend selection asserted
  through `apply()` itself (the ordering lives there, not in the pipeline
  constructor): auto reaches a configured remote model, auto needs no credential
  without one, and a remote backend reads its key from the environment — which is how
  the harness-home `.env` supplies it.

### Added
- **`protocol: full | compact`.** The mode's protocol section cost ~709 estimated
  tokens on every turn, which is a real drag on the "speed first" half of this
  mode's purpose. Rather than pick a side, the deployment picks: `full` (default,
  unchanged) or `compact`, which cuts the section by 41% (2482 → 1466 chars,
  ~709 → ~419 est. tokens per turn). Both render from **one** rule list, and
  `test/boot.test.mjs` asserts the shorter one still names every channel, every
  threshold and all three primitives, that neither embeds a dynamic value, that
  both are deterministic, and that `compact` does **not** alter the tool catalog.
  A shorter prompt that silently dropped a rule would be a behaviour change
  disguised as a formatting change.
- `README.zh.md` / `README.md` document the lever and the measured cost of both.
- A bundle-wide **text-integrity check**: every `.js`/`.mjs`/`.json`/`.yml`/`.md`/
  `.svg` file must decode as strict UTF-8 and contain no replacement character or
  mojibake. This bundle carries Chinese in the prompt, the UI copy and the docs, so
  the specific em-dash repair below deserved a general guard rather than a
  narrower heuristic. Verified with a negative control: a deliberately corrupt
  file makes the suite fail with the offending path.
- **`test/transport.test.mjs` (27 checks)** — the two surfaces nothing else
  covered. The HTTP decision backend (`typesafe` / `openrouter`) is exercised
  against a real loopback server: wire shape, **pre-dispatch redaction** of tokens,
  emails, internal hostnames and private IPs, a 401 that is *not* retried, a 429
  retried honouring `Retry-After`, a 5xx retried to its limit, an upstream-echoed
  API key scrubbed out of the error, a response with no `answers` treated as a
  failure, breaker short-circuiting and call-site timeouts. The `jev_gate` **tool**
  had no coverage at all before this — its deterministic refusal path, verdict
  mapping, risk annotation and unavailable-backend path are now asserted. Plus
  `truncateState`, `compact`, `unwrapField`, the `deadlineSignal` fallback path for
  a runtime without `AbortSignal.any`, backoff bounds, and the breaker's
  zero-clock sentinel.
- Because a suite that passes on its first run is the one worth distrusting, those
  assertions were **mutation-tested**: disabling pre-dispatch redaction, removing
  the key scrub, and retrying non-retryable statuses each made the suite fail on
  the matching check (4 of 4 mutations caught, source restored and re-run clean).
- **`bench/cache-probe.mjs` — the cache claim, measured against the live provider.**
  Every other measurement in this repository is taken on this side of the wire (the
  request is byte-stable) or against a scripted provider. "The provider reuses an
  identical prefix" is the one thing a plugin cannot prove about itself, and it is
  what the whole prompt discipline exists for, so the probe asks the actual service.
  Sending this bundle's frozen rubric as `system` with synthetic states:

  | call | prompt | cached | uncached |
  |---|---|---|---|
  | warm | 565 | 384 | 181 |
  | repeat, identical | 565 | 384 | 181 |
  | **different trailing state** | 565 | **384** | 181 |
  | **one byte changed at the start** | 586 | **0** | 586 |

  A byte-identical prefix with a different trailing state still reuses 384 of 565
  prompt tokens (68%) — the design's core bet, confirmed on the real provider. One
  byte moved to the front drops reuse to zero and raises input from 181 to 586
  tokens (3.2×), which is the measured cost behind keeping the prompt section
  static and appending every dynamic value instead. The probe is opt-in: without a
  credential it prints SKIP and exits 0, so CI runs it unconditionally. It sends
  only this bundle's own rubric and invented states — no session or user content.

### Fixed
- **The delete family is judged by its target, not its verb.** `rm -rf node_modules`
  was classified as an irreversible action and reached the gate, which would have
  asked the user to authorize routine build cleanup. A gate that does that trains
  its user to route around it, which is worse than not having one. Deleting a
  regenerable directory (`node_modules`, `dist`, `build`, `.next`, `__pycache__`,
  `coverage`, `tmp`, …) that does not escape upward is now ordinary work; every
  other recursive delete is still gated, and a root/home delete is hard-denied
  with no model call.
- **Pattern rules were matching the JSON envelope instead of the argument values.**
  `classifyAction` tested `JSON.stringify(args)`, which glues quotes and braces to
  the last token: a tokenizer reading a delete target saw `node_modules"}` and
  silently produced an empty target list, and an end-anchored hard rule
  (`rm -rf /`) could not match `{"command":"rm -rf /"}`. Rules now see the call's
  string values joined by newlines — which also prevents one rule from matching
  across two unrelated argument values.
- Added the missing destructive classes: infrastructure mutation
  (`terraform apply/destroy`, `kubectl delete`, `helm uninstall`, `aws … rm`,
  `docker rm`), database destruction (`DROP TABLE`, `DELETE FROM`) and discarding
  uncommitted work (`git checkout .`, `git restore .`, `git stash clear`). Their
  read-only counterparts (`terraform plan`, `kubectl get`, `docker ps`, `aws s3 ls`)
  are explicitly not gated.
- The labelled classifier fixture grew from 23 to 48 cases, with half of them
  deliberately "must not be gated" so a false positive is a test failure rather
  than a rounding error. Precision and recall remain 1.000.
- Repaired the last trace of an earlier encoding accident: eight em dashes in
  `index.js` had also lost the space that followed them (`—it` → `— it`). A
  bundle-wide UTF-8 mojibake guard keeps that class of damage from returning, and
  `.gitattributes` pins LF so a Windows edit pass cannot reintroduce it. The guard
  checks encoding, not dash spacing: an em dash without a following space is
  still legal text and is deliberately not asserted against.
- The protocol section now names **all five channels**. It previously described
  only the three primitives, leaving `route` and `risk` to be discovered from the
  tool description alone; the channel line is generated from one hint table, and a
  test fails if a channel is added without a hint.

### Added — prepared, not yet verified in a browser
- `RELEASING.md`: the publish checklist and the exact contract for adding a
  client UI badge later.

## [0.1.0] — 2026-10-01

First release. Verified against DeepSeek Harness `0.2.0-rc.2` (desktop profile).

### Added

- **Agent preset `jev`** — the shipped `standard` composition with every child
  row reproduced verbatim, plus this plugin. `standard` is untouched; both modes
  coexist.
- **One static prompt section** (`jev:protocol`, order 3050, fixed numeric order,
  `interpolate: false`) holding the mode protocol. Built once at activation and
  never rebuilt: no clock, counter, path, or session id, so it cannot invalidate
  prefix reuse from an early token.
- **Five typed decision channels** over the JEV primitives:
  `route` (choice), `risk` (score), `authorize` (noul), `grounded` (noul),
  `sufficient` (noul).
- **Three tools, registered once**: `jev_decide`, `jev_gate`, `jev_status`.
- **A two-stage action gate** on `tools/pre-execute`, prepended:
  a deterministic classifier (measured ~0.002 ms, no network) delegates ordinary
  work and refuses a few catastrophic shapes outright; only actions at or above
  `gateAtRisk` reach a model-backed `authorize` decision.
- **Escalation, never silent approval**: any undecidable path asks the user
  (`onGateFailure: escalate`), and under a `never` approval policy it returns a
  final denial instead of an `ask` that the approval service would auto-reject
  with a message about a user who was never asked.
- **An append-only metadata-only ledger** at
  `$DSH_HOME/storages/dsh-jev-mode/ledger-YYYY-MM-DD.jsonl`, one row per decision,
  each carrying `cacheReadTokens` — the measurement behind the cache claim. Rows
  hold the state hash and a redacted, length-capped summary, never the body.
- **Transport hardening**: circuit breaker, FIFO concurrency limiter, hashed TTL
  verdict cache keyed on `(channel, rubric version, engine, cuts, state)`, retry
  classification, per-call-site timeouts, token and session budgets.
- **A dynamic runtime context** (`jev:status`) for counters, which the harness
  appends after retained history and emits only on change.
- **Zero runtime dependencies**: Node builtins only, plain JSON Schema for tools,
  hand-rolled config normalization (the harness passes raw config through when a
  plugin declares no `Config`, as the first-party `auto-review` plugin also does).

### Verified

- 10 manifest checks, 24 patch checks, 54 boot checks, 22 end-to-end decision
  checks — 110 offline checks at the initial build; see Unreleased for the
  transport suite and the widened classifier fixture (143 in total now).
- Every tool `parameters` and `output.schema` compiled by the **real host
  validator**, plus a live tool result validated against its own output schema.
- Live mount: the plugin's activation side effect is present and the
  `include:preset-jev` row is in the running host's composed config.
- Measured (`bench/bench.mjs`): +4519 chars (~1291 est. tokens) per turn; section
  and tool catalog byte-identical across five activations; 10 identical decisions
  cost 1 provider call with the verdict cache and 10 without; gate classifier
  precision 1.000 / recall 1.000 over 23 hand-labelled cases. *(The prompt figure
  is superseded by Unreleased, which added the channel line: 4634 chars /
  ~1324 est. tokens, or 3618 / ~1034 with `protocol: compact`.)*

### Not verified, and not claimed

- The accuracy of the model-backed channel probabilities. That needs labelled
  real decisions, which this repository does not have.
- The live provider cache-hit rate. The plugin controls prefix byte-stability and
  records `cacheReadTokens`; the provider decides the rest.

### Known limitations

- Presets cannot be switched after a session's first turn.
- The gate covers native tool calls; the outer `run_code` transport is skipped.
- The gate classifier matches shapes by regex, not meaning.
- `session.snapshotEvents()` is a deprecated synchronous reader, used on the tail
  of an already-classified risky call only, under the same documented waiver the
  first-party `auto-review` plugin takes.
- No client UI badge. See `RELEASING.md` for the verified contract and why it was
  not shipped unverified.

