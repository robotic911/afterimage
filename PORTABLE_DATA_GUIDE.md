# Afterimage Portable Data Workflow

Use `portable-data/` to move curated app configuration and business records through Git without copying the whole Electron `userData` folder.

## What Is Included

- App settings that are safe to reuse across laptops.
- Countdown, layout, softcopy, beautification, print enable/copy settings, and bundled template override settings.
- Template metadata and uploaded template assets.
- Event metadata and uploaded landing assets.
- Scrubbed session/business history.
- Strip copy counts and revenue fields.
- Keychain sale counts, units, sheets, and revenue fields.
- A pricing snapshot for auditability.

## What Is Excluded

- `.env` files and Supabase service role or cleanup secrets.
- Admin PIN hash and salt.
- Selected printer queue name.
- Camera device selection.
- Absolute macOS, Windows, and Downloads paths.
- Generated customer PNG/GIF/video/keychain files.
- QR softcopy media and expiring Supabase paths/tokens.
- Electron cache, cookies, local/session storage, logs, and backups.

## Original Laptop

1. Fully close active customer sessions and avoid exporting while prints or records are being written.
2. Run:

   ```sh
   npm run data:export
   ```

3. Review the export summary.
4. Check changed files:

   ```sh
   git status
   ```

5. Commit the data and portability code:

   ```sh
   git add portable-data PORTABLE_DATA_GUIDE.md package.json scripts/portable-data.cjs electron.cjs .gitignore
   git commit -m "Update portable app data"
   ```

6. Push:

   ```sh
   git push
   ```

## Other Laptop

1. Pull latest changes:

   ```sh
   git pull
   ```

2. Install dependencies if needed:

   ```sh
   npm install
   ```

3. Restore data:

   ```sh
   npm run data:import
   ```

   This uses safe replace mode by default and creates a backup under the local Electron `userData/backups/` directory before overwriting app-owned data.

4. Start the app:

   ```sh
   npm start
   ```

5. Select the local camera and printer for that laptop.

## Import Modes

Replace mode is the default and recommended source-of-truth workflow:

```sh
npm run data:import -- --mode=replace
```

Merge mode is available for cautious record combining:

```sh
npm run data:import -- --mode=merge
```

Merge mode deduplicates by stable IDs and skips conflicting templates, events, or sessions instead of overwriting them.

## Testing With A Temporary Runtime Folder

Use this to verify an import without touching the real Electron data folder:

```sh
AFTERIMAGE_USER_DATA_DIR=/tmp/afterimage-import-test npm run data:import
```

On Windows PowerShell:

```powershell
$env:AFTERIMAGE_USER_DATA_DIR="$env:TEMP\\afterimage-import-test"
npm run data:import
Remove-Item Env:AFTERIMAGE_USER_DATA_DIR
```

## Important Warnings

- Do not commit `.env` or credential files.
- Do not operate two laptops as independent sources of truth and merge blindly.
- Export from one chosen source laptop, commit, push, then import on the other laptop.
- Generated customer media is not transferred by default, so reprint/keychain actions for old imported sessions may show `Media unavailable on this device`.
- Local printer and camera selection must be configured separately on each laptop.
