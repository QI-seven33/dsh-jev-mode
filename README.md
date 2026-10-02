# JEV decision mode for DeepSeek Harness Desktop

[中文说明](README.zh.md) · [Installation](INSTALL.zh.md) · [Validation and measurements](VALIDATION.md) · [Releases](https://github.com/QI-seven33/dsh-jev-mode/releases)

An optional preset that combines the standard Desktop tool capabilities with deterministic project reads, bounded JEV semantic selection, and a separate authorization gate. Independently developed and maintained by QI-seven33; this is an unofficial community plugin.

## Install

In Harness Desktop, open **Plugins**, install and enable:

```text
github:QI-seven33/dsh-jev-mode#v0.4.2
```

Alternatively, download [dsh-jev-mode-0.4.2.tgz](https://github.com/QI-seven33/dsh-jev-mode/releases/download/v0.4.2/dsh-jev-mode-0.4.2.tgz) and enter its absolute local path in the same installer. Restart Harness completely, then choose **JEV decision mode** in a new session. Cloning the repository alone does not activate the plugin.

Tested against **DeepSeek Harness Desktop 0.2.0-rc.2**. Other host versions and operating systems need separate validation. Ready-to-run JavaScript is included; there are no runtime dependencies or build/install lifecycle scripts.

## Enter your own key

Open **Settings → Models → JEV decision model → Edit**. Enter your personal TypeSafe API key and save. The plugin uses Harness's write-only credentials service under `TYPESAFE_API_KEY`. No shared key is included, and saved values are never returned to the browser or model conversation. Keep your existing DeepSeek main-model configuration.

The collapsed card opens the host modal on Edit. It supports save, replacement, removal and status refresh. The dot indicates a configured credential, not API connectivity. Environment-provided credentials are read-only; removing a stored key can expose an existing `.env` fallback.

These images are component-test previews using the actual host React/Modal with a stubbed credentials remote; they do not depict a live authenticated Desktop session.

![Collapsed model settings card](assets/settings-card.png)

![Credential edit dialog](assets/settings-dialog.png)

## What the mode does

| Task | Behavior |
| --- | --- |
| Explicit root package.json / README.md query | Code chooses the file; native read and permissions run; zero JEV selection calls. |
| Eligible short contrastive request, both fixed files available | JEV may select one fixed read. Valid confidence and selected probability must both reach 0.9; otherwise ordinary planning continues. |
| Risky operation | Hard rules run first. Risk 2+ operations use real human instruction history for semantic authorization. Host permission vetoes remain authoritative. |
| Ordinary code or document task | Standard planning and tools; no automatic advisory JEV calls. Quoted commands in document content are not treated as executions. |

Without a TypeSafe key, explicit reads still work, semantic reads fall back, and failed dangerous authorization checks escalate or deny. Manual `jev_decide` and `jev_gate` tools remain available for human-requested diagnostics; `jev_status` reports version and counters.

The system prompt section and complete tool catalog remain fixed within a session. Runtime notices append after retained history using the host's producer-owned V4 message contract. Dynamic tool pruning and status-prefix rewrites are avoided to preserve DeepSeek prefix reuse. Cache hits remain best-effort and are not guaranteed. The ledger stores metadata and hashes, not command bodies, reasons or credentials.

## Evidence and limits

The decision implementation is unchanged from 0.4.0; 0.4.2 adds desktop credential UI and separates global settings from preset behavior. The earlier controlled standard-vs-hybrid comparison achieved 28/28 scripted task successes in both arms and fewer main-model requests, but JEV-mode P95 was worse. These are small local measurements, not universal speed or accuracy claims. See [VALIDATION.md](VALIDATION.md) for exact scope.

Authorization thresholds 0.85 / 0.55 have not been calibrated for this domain. Real-world false-allow/false-block rates are unmeasured. An automatic grounded/sufficient verification loop and per-decision client badges are not shipped.

## Development

```sh
npm install --no-save --no-package-lock yaml@2
npm test
```

Native-host checks require Node 24 and the host module locations via `DSH_HOST_NODE_MODULES` / `DSH_HOST_NATIVE_NODE_MODULES`. CI runs offline checks on Node 20, 22 and 24 and explicitly reports absent-host skips. Live benchmark scripts are opt-in; see [bench/COMPARE.md](bench/COMPARE.md). Do not commit credentials, profiles or raw conversation traces.

[Acceptance steps](ACCEPTANCE.zh.md) · [Source attribution](PROVENANCE.md) · [Release procedure](RELEASING.md)

MIT License · Copyright 2026 QI-seven33.
