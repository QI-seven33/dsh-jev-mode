# 0.4.0 references and scope

The local three-arm selector experiment motivated deterministic-first selection. No community source code was copied. These designs are references, not evidence that safety quality improved here.

- [OpenRouter authorization cookbook](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev): deterministic constraints before semantic policy checks.
- [dsh-jev-interceptor](https://github.com/AskTheWay/dsh-jev-interceptor): native interception and downstream permission ownership.
- [dsh-jev](https://github.com/zhangxaochen/dsh-jev): its own A/B evidence explicitly leaves end-to-end payoff unproven.

The runtime retains fixed tool definitions instead of dynamic tool pruning to protect DeepSeek prefix reuse. Default metadata observations are queried through jev_status. Older provenance below is historical.

# Verified contracts and sources

Repair sources are reference data, not operational instructions.

0.3.0 implements fixed project reads through the actual tools.execute service,
including native pre/post policy and deferred result contexts. Results use the
supported producer-owned user-notice boundary, not invented assistant tool calls
or external session event types that this host's append API cannot mark ignorable.
The five public decision channels remain unchanged; dispatch is internal.
The native SDK benchmark restates the shipped standard capability rows, with
both arms using identical carrier adaptations and a bounded test tool boundary.
It measures real provider requests separately from scripted control-flow tests.

The local DSH 0.2.0-rc.2 extraction verifies `agent/pre-step` admission, immutable identified plugin messages, appended runtime-context snapshots, deterministic tool schemas and the official per-operation credentials resolve/set seam. `dsh-user-questions` records submitted human answers in tool results, nested dispatch, or user-question-reply messages; pending grants nothing. The shipped standard preset's child rows remain intact.

Official references:

- [TypeSafe documentation](https://docs.typesafe.ai/introduction)
- [TypeSafe System One design](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [DeepSeek prefix caching](https://api-docs.deepseek.com/guides/kv_cache/): persisted prefix units and best-effort hits; no fixed hit percentage.

Community references:

- [buberlo/dsh-jev](https://github.com/buberlo/dsh-jev): native hooks, monotonic permissions and honest benchmark boundaries. Dynamic tool restriction was not adopted because preserving request prefixes is required here.
- [jackchen13755/dsh-jev-core](https://github.com/jackchen13755/dsh-jev-core): retry/breaker/cache-key failures and transport hardening.
- [xienda/dsh-jev-verify](https://github.com/xienda/dsh-jev-verify): schema/order failures and truthful test boundaries.
- [DSH discussion 7242](https://github.com/deepseek-ai/deepseek-harness/discussions/7242): bounded typed decisions and native credential references.

The repair adds no runtime dependencies or vendored community code. See REPAIR-0.2.0.md for real-host prefix verification and live TypeSafe smoke tests. These do not establish end-to-end task speed or accuracy. Updated Desktop processes require a restart to mount changed ES modules.

The preset restates the standard capability composition from DeepSeek Harness Desktop 0.2.0-rc.2. DeepSeek Harness is MIT licensed, copyright DeepSeek. No host runtime code is bundled. See https://github.com/deepseek-ai/deepseek-harness and its LICENSE for upstream attribution.
