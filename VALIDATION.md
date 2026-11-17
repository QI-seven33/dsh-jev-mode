# Validation and measurement boundaries

## Version 0.4.6 deployment repair

The 0.4.5 linked Desktop installation was broken: its bare proxy-module import failed with ERR_MODULE_NOT_FOUND before HTTP dispatch. The earlier copied-profile test exercised native resolver hooks, and the live diagnostic supplied a module loader explicitly. Neither established that the linked Desktop plugin could load its transport. The earlier conclusion that the installed plugin was usable is withdrawn.

The actual installed Electron executable (44.7.0, Node 24.21.0) reproduced that failure from the real linked plugin directory without resolver hooks. In the same process, the public proxy export resolved from the real packaged host installation anchor inside ASAR; its dispatcher/request API and the fixed read-only system-registry query both worked. This isolates a deployment problem rather than inferring a new provider outage.

Version 0.4.6 obtains profileContext.installAnchor from the native launcher and resolves the public host export from it. It does not search workspaces, infer ASAR layout, install global hooks, vendor private host files or add a second HTTP library. Missing injection/export fails with JEV_PROXY_MODULE_UNAVAILABLE: zero HTTP traffic, no retry and no provider-breaker failure. Standard tools and native permission ownership remain unchanged. Packaged linked-installation tests and interactive Desktop acceptance are tracked separately; the initial deployment repair used no further real API calls. A subsequent bounded pre-release smoke is recorded below.

The complete local suite passes (40 node:test cases, zero skips, plus native persistence/read/permission/DeepSeek fixture suites). Deployment verification runs the installed Electron executable in Node mode against the real ASAR, with an isolated profile junction pointing at an external copy of the final package and no plugin node_modules. A request through the default loader succeeds before global resolver hooks are installed. Full native host boot then creates standard/JEV agents, verifies all 40 standard tool schemas remain identical, executes jev_status returning 0.4.6, and invokes native jev_decide authorize through a local synthetic proxy, returning the fixture's expected deny. Two local fixture HTTP requests; zero real-model calls. The real Electron process also successfully reads the enabled Windows system proxy. This is deployment and control-flow evidence, not a new live-provider accuracy or latency claim. Existing UI processes may cache 0.4.5 until fully restarted; user-session acceptance remains separate.

### Bounded live check and maintainer feedback

The maintainer reported Desktop 0.4.6 returning real results on all five channels, with budget and ledger updates. This is user-reported interactive acceptance, not an independently inspected private transcript. Boundary probabilities in that report do not establish false-allow rates or justify changing thresholds.

A separate pre-release check ran the actual installed 0.4.6 modules in the installed Electron/ASAR runtime, using the default host-anchor loader and the native credential service in read-only mode. Five synthetic states were sent to pinned jev-1.13.0, at most five HTTP requests with zero retries. Windows system-proxy discovery was used without proxy environment overrides; read-only snapshots confirmed rule mode and TUN disabled before and after. No private session content, settings or credentials were written or copied.

| Channel | Observed result | Time |
| --- | --- | --- |
| route | inspect, selected probability 0.46 | 559ms |
| risk | level 0, probability 1.00 | 447ms |
| authorize | deny, Noul 0.03 after explicit revocation | 246ms |
| grounded | allow, Noul 0.98 | 255ms |
| sufficient | allow, Noul 0.97 | 268ms |

All five responses were structurally valid; usage totaled 2,091 input and 144 output tokens. The route selection is below the existing 0.9 automatic-selection cut and would retain ordinary planning. No thresholds or models were adjusted. These deliberately simple cases establish current connectivity and expected basic behavior only; there is no baseline, repeatability estimate, calibration study or general performance claim. Native permission/gate failure paths remain covered by offline and local fixture tests; no real destructive command, publication or force-push was used as a safety experiment.

## Version 0.4.5 compatibility candidate

Local target: Windows, installed Desktop 0.2.2-rc.3. The preset reproduces that host's standard child configuration exactly after excluding the single JEV row; 28 enabled native plugin entry points resolve. The old subagent-control/list-agents export no longer resolves. Runtime tool execution now uses correlated batches through the native executor, not direct filesystem access.

The complete suite passes against the newly extracted installed host, including none/zstd cold reopen, retained model history/catalog, controlled reads, denial, revocation, cancellation and throttling. The node:test portion passes 38 cases, including batch ownership/denial, no retry after an uncertain outcome, authorization invalidation after a host working-directory transition, and scoped HTTP proxy routing. These automated suites use synthetic adapters and loopback HTTP, not paid model APIs or safety-accuracy labels. A separately bounded live connectivity check is described below.

Model jev-1.13.0, Noul thresholds 0.85/0.55, gateAtRisk=2 and classifier limits remain unchanged. The candidate has not been publicly released. New standard-host capabilities change the cross-version composition; per-session tool and history stability remains required. Full Desktop restart/new-session acceptance is separate from these isolated tests. The settings client is unchanged.

### Rule-mode connectivity repair (2026-11-17)

The unadapted Node route received HTTP 451 with a provider region-denial response; an unauthenticated probe through the existing system proxy received HTTP 403 requiring a key. Neither status proves the user has no saved key or must enable Global/TUN. The native credential service confirmed an existing key without exposing it.

JEV HTTP now uses the launch proxy policy, or the enabled Windows manual HTTP(S) system proxy when no launch proxy is explicitly configured. It creates request-owned dispatchers through the installed host's public dsh-http-proxy API and uses their own request API, avoiding Node/host undici handler incompatibility. It does not mutate global dispatchers, environment, Windows or Clash settings. Proxy errors do not cause a direct retry. Windows exact-host/wildcard bypass, native NO_PROXY/loopback bypass, abort, redirect refusal and cleanup have local regression coverage. PAC/WPAD and SOCKS-only system proxies are unsupported and fail explicitly.

Bounded live diagnosis made three authenticated attempts: the first failed without a retained detailed cause; the second returned a structurally valid Choice, but the diagnostic scorer incorrectly compared its probability with the expected choice id, so it is not evidence of routing correctness. The final attempt used the repaired transport, no proxy environment overlay, the existing native credential service and synthetic context forbidding publication. It returned a valid authorize Noul of 0.06 in 690ms, one HTTP request, zero retries. Read-only local controller snapshots confirmed Clash rule mode and TUN disabled before and after. No real publication was attempted. This verifies one reachable authenticated route, not long-term stability, all five channels, geographic availability or safety accuracy. The diagnostic scorer issue is recorded rather than counted as a product failure.


## Version 0.4.4

This release closes the reliability work only. It retains the compact settings card and native edit modal from 0.4.3; the maintainer reported those UI changes working normally. It does not introduce a new selector, preloading workflow, transaction command or general task-performance optimization. The separately retained `/jev-json-set` prototype is experimental, default-off and excluded from both the install package and release source snapshot. Its timing results do not describe 0.4.4.

The production model remains pinned to `jev-1.13.0`, authorization remains Noul, and the authorization thresholds remain 0.85 / 0.55 with gateAtRisk=2. No model or threshold tuning is included. Research into additional JEV involvement in ordinary conversations, skill selection and preloading is stopped.

Native DeepSeekAdapter loopback verification covers signed reasoning in both tool and non-tool historical turns, auxiliary thinking-off without changing the main high effort, plugin-notice serialization, unchanged prefix/tools/user isolation id, SSE keep-alives and an absolute deadline. V4 none/zstd cold reopen now also verifies reasoning retention. A new offline regression reproduces the AbortSignal freeze failure at the native signal-composition boundary; request data stays immutable after the repair. The node:test portion passes 29 tests, alongside the existing offline/native suites.

A limited live DeepSeek smoke ran two read tasks once per arm: 4/4 passed, eight main-model requests total, zero JEV calls. Standard used six requests and the hybrid used two; this exercises existing deterministic reads, not the new JEV transport. Each arm has only two observations, so no general speed, P95, accuracy or calibration claim is made. Detailed absolute token counts, reasoning-metric limits and current DeepSeek protocol findings are in [the focused report](reports/2026-10-17-deepseek.zh.md).

Fourteen new transport tests cover server retry delays (seconds, HTTP-date and retry-after-ms), budget refusal, instance-local cooldown, concurrent extension and expiry, cancellation, the second credential lookup, secret-safe failures, half-open recovery, authorization degradation, advisory-cache accounting and numeric-only ledger metadata. Native Desktop 0.2.0-rc.2 regressions additionally refused four rate-limited protected writes under escalate/deny, with one HTTP request per two attempts. Existing allowed-write, revocation/cancellation, V4 none/zstd and retained prefix/tool-catalog checks pass. All three protocol variants and the public catalog also match v0.4.3 byte for byte. The candidate package installs through native PluginManager in a fresh isolated profile; no personal profile or credentials are used. Public transport results are tracked separately in the Release notes; no new-host compatibility claim is made.

An interleaved loopback comparison against immutable v0.4.3 used eight pairs with a 429 response, Retry-After: 30 and a 250ms decision deadline. Median time to unavailable was 259.75ms vs 1.65ms; observed P95 was 264.7ms vs 4ms. Both arms returned unavailable in all eight cases. A five-call sequential burst sent five HTTP requests in v0.4.3 and one in the candidate. This deliberately injected fault demonstrates prompt degradation and backpressure, not task completion speed, production P95 or improved authorization accuracy. Reproduce with `node bench/transport-budget.mjs`; it calls loopback only.

Three synthetic live Noul calls to pinned jev-1.13.0 succeeded, with the response model matching the requested version: 536/418/237ms, 1,166 total input tokens and 60 output tokens, no retries. These are connectivity observations, with no live baseline or statistical inference. Credentials were resolved through the host service in memory; legacy migration was disabled and no credentials were written or exported.

Cooldown is local to one HTTP engine instance and shared across its channels/sessions; it is not organization-wide coordination or a persistent cache. Only explicit server delays on 429/503 create shared cooldown. A following call degrades immediately even if its individual deadline could outlast the remaining cooldown. This can cause more ordinary-planning fallbacks or approval prompts during provider throttling; it never grants permission. Already in-flight requests cannot be recalled. Main-model prefix bytes, public tool schemas and authorization policy remain unchanged. The ledger still waits on filesystem writes; this candidate does not remove that known latency boundary. See [the development report](reports/2026-10-17-transport-budget.zh.md).

## Known limitations retained in 0.4.4

The regex classifier is incomplete. Rechecked on the retained 0.4.4 implementation, the following command strings classify at risk 1, below the default gate threshold of 2, and therefore do not trigger the automatic JEV authorization check:

```text
npm --prefix subproject publish
git -C subproject push
gh api --method POST repos/example/repo/releases
python deploy.py
```

These were classified without executing commands. A low risk label is not evidence of safety or authorization. Keep native sandbox/path boundaries and approvals; the plugin does not inspect every dangerous operation. Unknown scripts can have effects that their command names do not reveal.

This is a gap in JEV-gate coverage, not evidence that native permissions were bypassed. Evaluating only actions that reached JEV would omit these cases. Production false-allow/false-block rates remain unmeasured; no safety-accuracy improvement is claimed. Classification and permission policy are deliberately unchanged in this maintenance release.

The automatic authorization question is Noul, with no Choice criteria. `allow`, `ask` and `deny` are local threshold outcomes, not options sent to JEV. Choice option-order experiments apply to dispatch/routing and any future skill selector; authorization tests instead need instruction/revocation, scope, evidence completeness, repeatability and model-version controls.

## Retained 0.4.3 validation

Version 0.4.3 changes UI metrics and decision-boundary reliability; it adds no skill-selection feature, changes no authorization threshold, and does not establish new live performance or safety-accuracy results. See [the audit](reports/2026-10-17-update.zh.md) and [the follow-up review](reports/2026-10-17-followup.zh.md).

The two scripted follow-up findings were fixed before that release: automatic approvals are invalidated when human history or execution arguments change during pending decision/ledger/downstream waits; user cancellations and queued expiry do not open the provider breaker. Credential lookup is deadline bounded. Twelve focused tests pass. Native-host tests include an authorized isolated write control and pending/downstream revocation and user cancellation cases; stale/cancelled writes did not execute. These tests use scripted responses, not real-model safety labels.

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
