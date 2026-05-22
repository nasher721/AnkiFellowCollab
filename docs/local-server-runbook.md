# DeckBridge Local Server Runbook

This workspace can run DeckBridge as a local server backed by the Supabase stack on this computer.

## Current local endpoints

- App/API: `http://192.168.1.211:4175`
- Supabase API/Auth/Realtime: `http://192.168.1.211:54321`
- Supabase Studio: `http://127.0.0.1:54323`

The machine-local secrets and generated owner login are stored in `.env.local-server`, which is ignored by git.

## TLS and network boundary

For self-hosted access, publish only the TLS reverse proxy on ports `80` and `443`. Keep DeckBridge on `127.0.0.1:4175` and Supabase on `127.0.0.1:54321`; do not expose either service directly to the LAN or internet.

Use Caddy to terminate TLS and proxy to DeckBridge:

```powershell
Copy-Item .\deploy\Caddyfile C:\Caddy\Caddyfile
caddy validate --config C:\Caddy\Caddyfile
caddy reload --config C:\Caddy\Caddyfile
```

Production environment values:

```powershell
DECKBRIDGE_HOST=127.0.0.1
DECKBRIDGE_PORT=4175
SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_URL=https://deckbridge.example.com
CORS_ORIGIN=https://deckbridge.example.com
```

Windows firewall example:

```powershell
New-NetFirewallRule -DisplayName "DeckBridge TLS HTTP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80
New-NetFirewallRule -DisplayName "DeckBridge TLS HTTPS" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443
New-NetFirewallRule -DisplayName "Block DeckBridge app direct" -Direction Inbound -Action Block -Protocol TCP -LocalPort 4175
New-NetFirewallRule -DisplayName "Block Supabase direct" -Direction Inbound -Action Block -Protocol TCP -LocalPort 54321
```

## Start after reboot

1. Start Docker Desktop.
2. Start Supabase:

   ```powershell
   npx supabase start
   ```

3. Build the frontend against the current local Supabase URL:

   ```powershell
   npm run build:local-server
   npm run package:anki-addon
   ```

4. Start DeckBridge:

   ```powershell
   npm run start:local-server
   ```

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:4175/api/health
Invoke-WebRequest http://192.168.1.211:4175/
Invoke-WebRequest http://192.168.1.211:54321/auth/v1/settings
```

For self-hosted TLS, also verify:

```powershell
Invoke-WebRequest https://deckbridge.example.com/api/health
Invoke-WebRequest http://deckbridge.example.com/api/health -MaximumRedirection 0
```

Expected: HTTPS health returns `200`; HTTP returns a `308` redirect to the HTTPS URL.

## Migrated owner login

The migrated local JSON owner account uses `LOCAL_DECKBRIDGE_OWNER_EMAIL` and `LOCAL_DECKBRIDGE_OWNER_PASSWORD` from `.env.local-server`.

## Locked-down keys

Keep `.env.local-server` out of synced shares, screenshots, issue attachments, and frontend builds. The file contains the Supabase service role key, owner bootstrap login, and local deployment settings.

After editing `.env.local-server`, lock its ACL on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lock-self-host-secrets.ps1 -EnvFile .env.local-server
```

On Linux self-hosts, store the equivalent environment file outside the repository and restrict it to root and the DeckBridge service account:

```bash
sudo chown root:deckbridge /etc/deckbridge/deckbridge.env
sudo chmod 0640 /etc/deckbridge/deckbridge.env
```

Rotate the Supabase service role key and add-on tokens after any suspected exposure. Add-on tokens are shown once, stored only as hashes, expire by default, and can be revoked from the token list.

## If the LAN IP changes

Update these values in `.env.local-server`:

- `SUPABASE_URL`
- `VITE_SUPABASE_URL`
- `CORS_ORIGIN`

Then rebuild and restart:

```powershell
npm run build:local-server
npm run package:anki-addon
npm run start:local-server
```

## Data and backups

Local Postgres and Storage live in Docker volumes managed by Supabase CLI. Local DeckBridge app state, when present, lives in `.deckbridge/`.

Create a local backup before migrations, machine moves, or any change that could affect canonical server data:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local-server.ps1
```

The backup script writes timestamped folders under `.deckbridge-backups/` by default. Each backup contains:

- `postgres.dump`: a custom-format Postgres dump from `supabase_db_anki-collab`.
- `storage/`: a copy of `/var/lib/storage` from `supabase_storage_anki-collab`.
- `deckbridge-state.zip`: an archive of `.deckbridge/`, if that directory exists.
- `manifest.json`: backup metadata and the matching restore command.

To preview backup work without creating files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local-server.ps1 -DryRun
```

To use a different Supabase project id or backup destination:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local-server.ps1 -ProjectId anki-collab -Destination D:\DeckBridgeBackups
```

Restore from a backup only after confirming the target Supabase local stack is the one you intend to overwrite. The restore process cleans and reloads Postgres, clears and restores Storage, and restores `.deckbridge/` when the backup includes `deckbridge-state.zip`. If `.deckbridge/` already exists, it is renamed before the archived state is expanded.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-local-server.ps1 -BackupPath .deckbridge-backups\anki-collab-YYYYMMDD-HHMMSS
```

For a custom project id:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-local-server.ps1 -BackupPath .deckbridge-backups\anki-collab-YYYYMMDD-HHMMSS -ProjectId anki-collab
```
