# Validation and measurement boundaries

## Unreleased 0.4.4 transport candidate

Fourteen new transport tests cover server retry delays (seconds, HTTP-date and retry-after-ms), budget refusal, instance-local cooldown, concurrent extension and expiry, cancellation, the second credential lookup, secret-safe failures, half-open recovery, authorization degradation, advisory-cache accounting and numeric-only ledger metadata. Native Desktop 0.2.0-rc.2 regressions additionally refused four rate-limited protected writes under escalate/deny, with one HTTP request per two attempts. Existing allowed-write, revocation/cancellation, V4 none/zstd and retained prefix/tool-catalog checks pass. All three protocol variants and the public catalog also match v0.4.3 byte for byte. The candidate package installs through native PluginManager in a fresh isolated profile; no personal profile or credentials are used. No new-host compatibility or public 0.4.4 transport claim is made.

An interleaved loopback comparison against immutable v0.4.3 used eight pairs with a 429 response, Retry-After: 30 and a 250ms decision deadline. Median time to unavailable was 259.75ms vs 1.65ms; observed P95 was 264.7ms vs 4ms. Both arms returned unavailable in all eight cases. A five-call sequential burst sent five HTTP requests in v0.4.3 and one in the candidate. This deliberately injected fault demonstrates prompt degradation and backpressure, not task completion speed, production P95 or improved authorization accuracy. Reproduce with `node bench/transport-budget.mjs`; it calls loopback only.

Three synthetic live Noul calls to pinned jev-1.13.0 succeeded, with the response model matching the requested version: 536/418/237ms, 1,166 total input tokens and 60 output tokens, no retries. These are connectivity observations, with no live baseline or statistical inference. Credentials were resolved through the host service in memory; legacy migration was disabled and no credentials were written or exported.

Cooldown is local to one HTTP engine instance and shared across its channels/sessions; it is not organization-wide coordination or a persistent cache. Only explicit server delays on 429/503 create shared cooldown. A following call degrades immediately even if its individual deadline could outlast the remaining cooldown. This can cause more ordinary-planning fallbacks or approval prompts during provider throttling; it never grants permission. Already in-flight requests cannot be recalled. Main-model prefix bytes, public tool schemas and authorization policy remain unchanged. The ledger still waits on filesystem writes; this candidate does not remove that known latency boundary. See [the development report](reports/2026-10-17-transport-budget.zh.md).

## Version 0.4.3 and known classifier limits

Version 0.4.3 changes UI metrics and decision-boundary reliability; it adds no skill-selection feature, changes no authorization threshold, and does not establish new live performance or safety-accuracy results. See [the audit](reports/2026-10-17-update.zh.md) and [the follow-up review](reports/2026-10-17-followup.zh.md).

The regex classifier is incomplete. The following command strings classify at risk 1, below the default gate threshold, in the reviewed source:

```text
npm --prefix subproject publish
git -C subproject push
gh api --method POST repos/example/repo/releases
python deploy.py
```

These were classified without executing commands. A low risk label is not evidence of safety or authorization. Keep native sandbox/path boundaries and approvals; the plugin does not inspect every dangerous operation. Unknown scripts can have effects that their command names do not reveal.

The automatic authorization question is Noul, with no Choice criteria. `allow`, `ask` and `deny` are local threshold outcomes, not options sent to JEV. Choice option-order experiments apply to dispatch/routing and any future skill selector; authorization tests instead need instruction/revocation, scope, evidence completeness, repeatability and model-version controls.

The two scripted follow-up findings were fixed before release: automatic approvals are invalidated when human history or execution arguments change during pending decision/ledger/downstream waits; user cancellations and queued expiry do not open the provider breaker. Credential lookup is deadline bounded. Twelve focused tests pass. Native-host tests include an authorized isolated write control and pending/downstream revocation and user cancellation cases; stale/cancelled writes did not execute. These tests use scripted responses, not real-model safety labels.

## Package validation

The selection and authorization policy remains the 0.4.0 design. The 0.4.3 implementation adds validation, cancellation and authorization-freshness guards; 0.4.1/0.4.2 introduced credential settings and split entry points. Existing historical performance results are not new 0.4.3 measurements.

Verified locally against Desktop 0.2.0-rc.2: bundle installation in a fresh isolated profile through the native PluginManager; bundle enabling, composed preset, settings anchor and client-module discovery; native tool schema/permissions contracts; V4 persistence; secret scanning; transport/fallback, quoted-command, selection and credential-service regressions. Browser checks use actual host React/Modal and the real plugin component with stubbed remote credentials. They do not prove API connectivity or compatibility with every desktop release.

GitHub CI verifies offline contracts on Node 20/22/24 and reports absent-host skips explicitly. Public repository and Release download checks are reported in the Release notes after publication. No personal profile, API key or raw live conversation is included.

## Earlier controlled comparison: 0.4.0

Same main model/configuration, paired starting fixtures, randomized ordering (seed 20261002), 14 tasks × 2 repeats × 2 arms = 56 formal executions. Dangerous operations used an isolated test boundary. These are small local samples; the later UI changes were not benchmarked again.

| Aggregate | Standard | Hybrid JEV mode |
| --- | ---: | ---: |
| Scripted task success | 28/28 | 28/28 |
| Median elapsed time | 3158.5 ms | 1807 ms |
| P95 elapsed time | 4974 ms | 6250 ms |
| Mean main-model requests | 3.1786 | 2.1071 |
| Main-model input cache hit proportion, including initial cold traffic | 96.9905% | 94.6457% |

For 12 explicit-read executions per arm, main-model requests dropped from 3 to 1 with zero JEV selection calls; median elapsed time was 2959 ms vs 1553 ms. This benefit belongs to deterministic front-loading, not JEV intelligence.

The semantic subset had only four executions per arm: mean main-model requests 2.75 vs 1, one JEV selection call per hybrid execution, medians 2835.5 ms vs 1945.5 ms. This is preliminary evidence for a narrow semantic selector, not broad accuracy validation. Eight hybrid ordinary-mutation runs had zero advisory JEV calls.

A separate eight-execution warm-prefix probe (four per arm) recorded main-model cache proportions 96.7345% vs 96.3102%, median times 1686.5 ms vs 940 ms, and main requests 2 vs 1 with zero JEV calls. Cache measurements belong to the main model; JEV usage is accounted separately.

P95 worsened in the formal comparison. Neither guaranteed speed nor an invariant cache percentage is claimed. Real-world authorization false-allow and false-block rates were not measured; thresholds are uncalibrated. Tests prove execution and permission control flow, not production safety accuracy. See bench/COMPARE.md for reproduction controls.
