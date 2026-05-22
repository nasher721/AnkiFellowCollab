# DeckBridge Local Server Runbook

This workspace can run DeckBridge as a local server backed by the Supabase stack on this computer.

## Current local endpoints

- App/API: `http://192.168.1.211:4175`
- Supabase API/Auth/Realtime: `http://192.168.1.211:54321`
- Supabase Studio: `http://127.0.0.1:54323`

The machine-local secrets and generated owner login are stored in `.env.local-server`, which is ignored by git.

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

- Local Postgres and Storage live in Docker volumes managed by Supabase CLI.
- Local JSON source data remains in `.deckbridge/state.json`.
- Back up both the Supabase database and storage volumes before treating this machine as the canonical server.
