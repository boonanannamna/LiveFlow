# LiveFlow GitHub auto update

Repository: `https://github.com/boonanannamna/LiveFlow`

## One-time GitHub secrets

Add these under **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key stored outside this repository.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: empty for the current key. Prefer rotating to a password-protected key before public distribution.

Never commit the private key or `.env` file.

## Publish an update

1. Set the same semantic version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit the changes.
3. Push a matching tag, for example `v0.1.8`.
4. GitHub Actions publishes a Release containing the signed Windows updater and `latest.json`.
5. Installed clients detect the published release and require installation before login.

The application checks:

`https://github.com/boonanannamna/LiveFlow/releases/latest/download/latest.json`
