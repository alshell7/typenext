# Releasing TypeNext

Every public release requires Windows x64, Apple Silicon macOS and Intel macOS assets. A successful build for one platform is insufficient to publish.

The release workflow uses `windows-2022`, `macos-15` and `macos-15-intel` with explicit matching Rust targets. GitHub currently documents `macos-15` as ARM64 and `macos-15-intel` as Intel; see the [hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Linux remains a source-build/check target and is not a required 0.1.1 binary asset.

Before tagging, commit matching versions in package.json, package-lock.json, Cargo.toml, Cargo.lock and tauri.conf.json, reviewed license notices and a docs/release-notes/vVERSION.md. `node scripts/prepare-release.js v0.1.1` checks local metadata and icons without changing versions, Git state, tags or remotes. It does not require an empty working directory and does not publish anything.

Push the reviewed release commit to the repository, create its version tag, and push that tag. The workflow also supports manual dispatch naming an existing tag. It checks out the tagged commit and refuses mismatched version or MIT metadata, missing license resources, invalid icons or absent release notes. Live-provider tests remain disabled in CI.

After lightweight preparation, native builds and the frontend gate run in parallel. The frontend gate runs type checking, lint, unit/training tests, production build and offline browser regressions. Every required Windows/Mac build runs frontend unit tests, native Rust tests and clippy on its actual architecture. Windows also runs the isolated WebView2/crash-restart smoke without optional model downloads. Mac CI verifies application signatures, native binary architecture and DMG integrity; it does not perform a native WKWebView interaction test.

Build jobs cannot create a GitHub release. They collect the locked target's native license files, build installers, and upload workflow artifacts with version/commit/SHA-256 manifests. Missing published licenses require reviewed copies under public/notices/native-source-licenses/<name>-<version>, pinned to the package's VCS revision and source with checked hashes. Packages declaring MPL-2.0 include their corresponding published source in the native notices. No license is fetched opportunistically during packaging.

The single publish job starts only after all three native builds and the frontend gate succeed. It requires these complete assets:

| Target            | Required public assets                                                       |
| ----------------- | ---------------------------------------------------------------------------- |
| Windows x64       | setup.exe, MSI, portable ZIP containing TypeNext.exe and licensing resources |
| Apple Silicon Mac | DMG and ZIP containing TypeNext.app and licensing resources                  |
| Intel Mac         | DMG and ZIP containing TypeNext.app and licensing resources                  |
| All targets       | SHA256SUMS.txt                                                               |

After verifying the downloaded manifests, sizes, hashes and archive license payloads, the job creates a private draft or resumes its own draft. It uploads all eight assets, checks their remote sizes, uploaded states and SHA-256 digests using GitHub's [release-assets API](https://docs.github.com/en/rest/releases/assets), then makes the release public in one final operation. A failed build or upload leaves no partial public release. A failed upload may leave a draft for the next run. An already public release is never modified by this workflow; unexpected manually added draft assets require review rather than automatic deletion.

GitHub Actions must be enabled with permission for the publish job's GITHUB_TOKEN to write repository contents. The remote tag must exist and continue to point to the tested commit. Re-running the existing-tag workflow can resume a failed draft without creating a new tag. Required environment approvals can be configured by maintainers if desired; this workflow does not add an approval pause itself.

The initial workflow uses ad-hoc macOS signing (`APPLE_SIGNING_IDENTITY=-`) and leaves Windows binaries unsigned. Ad-hoc signing is recommended by [Tauri's GitHub pipeline guide](https://v2.tauri.app/distribute/pipelines/github/) for unsigned Apple Silicon downloads. It establishes bundle integrity and does not identify a trusted publisher or provide notarization. For trusted macOS distribution, configure a Developer ID Application certificate and notarization following [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) and update the workflow to import the certificate and use its identity. Windows trusted signing requires a suitable signing certificate/service and corresponding [Tauri signing configuration](https://v2.tauri.app/distribute/sign/windows/). SHA-256 checksums do not replace publisher signatures.

In-app updating is disabled. No updater key, latest.json, updater signatures or automatic update promise is part of 0.1.1.
