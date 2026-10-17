# Maintaining releases

The repository includes runnable JavaScript and a dsh.bundle manifest; consumers do not build it. Version 0.4.4 is a reliability-only release: retain the existing UI, model and authorization policy, and exclude untracked research and the default-off JSON transaction prototype.

1. Run the offline suite and native-host regressions against the target Desktop version. Inspect the change, scope and user acceptance steps.
2. Create a clean snapshot from the reviewed tracked files, not the developer's mixed working directory. Scan that snapshot for credentials. Exclude profiles, environment files, raw traces, untracked experiments and private historical Git content. Run checks against this exact snapshot.
3. Update the version and pinned install URLs together, then commit and tag the reviewed tree.
4. Run npm pack from the reviewed snapshot and inspect its file list. Verify every packed file against the tagged commit. Upload the versioned tgz, clean source zip and SHA256SUMS.txt to a matching GitHub Release; do not replace an already-published version with different bytes.
5. Install the public artifact through native PluginManager in a fresh isolated profile. Check enabling, preset composition, global settings and client-module discovery. Report which transport paths actually passed.
6. Publish accurate release notes, including skips and compatibility limits. Do not claim safety calibration or universal performance gains.

The plugin is listed in awesome-dsh-plugin. Check the live entry and existing update PRs before changing its pinned tarball. Update an open matching PR when possible; if the prior update was already merged, open one focused new version-update PR. Keep its description and category unchanged. Catalog merging remains the maintainers' decision. The entry template is in .github/community-entry.yml.
