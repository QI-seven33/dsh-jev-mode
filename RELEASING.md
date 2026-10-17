# Maintaining releases

The initial public release is v0.4.2 under QI-seven33/dsh-jev-mode. The repository includes runnable JavaScript and a dsh.bundle manifest; consumers do not build it.

1. Run the offline suite and native-host regressions against the target Desktop version. Inspect the change, scope and user acceptance steps.
2. Scan only the reviewed source snapshot for credentials. Exclude profiles, environment files, raw traces and private historical Git content.
3. Update the version and pinned install URLs together, then commit and tag the reviewed tree.
4. Run npm pack and inspect its file list. Upload the versioned tgz, clean source zip and SHA256SUMS.txt to a matching GitHub Release.
5. Install the public artifact through native PluginManager in a fresh isolated profile. Check enabling, preset composition, global settings and client-module discovery. Report which transport paths actually passed.
6. Publish accurate release notes, including skips and compatibility limits. Do not claim safety calibration or universal performance gains.

Community discovery uses the dsh-plugin topic and the official Show Your Plugins! Discussion category. The awesome-dsh-plugin directory requires repository age of at least one day and maintainer review. The plugin is listed through catalog PR #6499. Its entry template is in .github/community-entry.yml; each pinned tarball update still requires a catalog PR.
