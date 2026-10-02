# Validation and measurement boundaries

## Current package: 0.4.2

The current release runs the 0.4.0 decision implementation. Changes in 0.4.1/0.4.2 concern credential settings, native-modal interactions, and separate global settings/preset loading.

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
