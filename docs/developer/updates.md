# In-app updates

The desktop app uses the [Tauri updater plugin](https://v2.tauri.app/plugin/updater/). It reads a static feed from the latest GitHub release and installs only payloads signed with the TypeNext key.

## Parts

| Part | Where |
| --- | --- |
| Public key and feed URL | `src-tauri/tauri.conf.json` → `plugins.updater` |
| Signed update artifacts (release builds only) | `src-tauri/tauri.release.conf.json` → `bundle.createUpdaterArtifacts` |
| Private key and its password | `.keys/` on the maintainer's computer (ignored by Git), and the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| Check, download and install | `src/services/updater.ts` |
| Notice and settings | `src/notebook/UpdateNotice.tsx`, `src/notebook/preferences/UpdatesPane.tsx` |
| Save, stop servers, restart | Rust commands `prepare_for_update`, `cancel_update`, `restart_for_update` in `src-tauri/src/lib.rs` |
| Feed and signatures in the release | `scripts/release/stage-artifacts.mjs`, `scripts/release/lib.mjs` (`buildUpdaterFeed`), `scripts/release/verify-artifacts.mjs` |

## How a release makes an update

1. `release.yml` builds with `--config src-tauri/tauri.release.conf.json` and the two signing secrets. The bundler writes a `.sig` file next to each update payload.
2. `stage-artifacts.mjs` adds the payload and its signature to the platform manifest:
   - Windows: the NSIS `_setup.exe` (also a normal download).
   - macOS: `TypeNext_<version>_macos_<arch>.app.tar.gz`.
3. `verify-artifacts.mjs` checks every manifest and writes `latest.json` with the version, the release notes and one entry for each of `windows-x86_64`, `darwin-aarch64` and `darwin-x86_64`. `SHA256SUMS.txt` covers it.
4. `publish.mjs` uploads all 11 assets and publishes the release as latest. The app reads `https://github.com/alshell7/typenext/releases/latest/download/latest.json`.

PR checks build with `--no-bundle`, so they do not need the private key.

## In the app

- Automatic checks start 12 seconds after launch and repeat every six hours, while **Check for updates automatically** is on.
- With **Download updates in the background** on, a found version downloads and is verified at once. The notice shows when it is ready.
- **Restart to update** saves the notebook, waits for the save, then calls `prepare_for_update`. That allows the exit and stops the embedding and speech servers. On Windows the installer then ends the process (passive mode). On macOS the app calls `restart_for_update`.
- If any step fails, `cancel_update` restores the "Save before closing?" guard and the notice shows the reason.
- A release with no `latest.json` (0.2.0 and earlier) counts as "no update".

## The signing key

- Keep a copy of `.keys/` somewhere safe (for example a password manager). **Without the private key, installed copies cannot receive updates.**
- Never commit the key or put it in an issue, log or `.env` file. Tauri does not read signing keys from `.env`.
- To make a new key: `npx tauri signer generate --ci -w .keys/updater.key -p "<password>"`. Put the new public key in `tauri.conf.json`, and set both secrets with `gh secret set … < file`. Copies with the old public key cannot verify the new signatures, so ship the new key in a release signed with the old key first.

## Test locally

- `npx vitest run src/services/updater.test.ts src/notebook/UpdateNotice.test.tsx` covers checks, background download, save-first install, failures and the notice.
- `node --test scripts/release/release.test.mjs` covers signatures in the manifests and the feed.
- `node scripts/release/collect-rust-notices.mjs <target>` must pass for each target after a dependency change.
