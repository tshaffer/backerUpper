# backerUpper

A local app for backing up data from your apps to external drives. You choose what to back up, it tells you which drives to mount, shows a dry-run plan, then runs the backup and verifies it.

The first version covers Tedography only. Apps are defined in `config/backerupper.config.json`, so adding one is mostly a config change.

## Running it

Requires Node, pnpm, `mongodump`, and Homebrew rsync 3.x (`/opt/homebrew/bin/rsync`).

Run it from your own Terminal, because macOS grants drive access per app, and Terminal can already read `SHAFFEROTO`.

```bash
cd ~/src/backerUpper
pnpm install
pnpm start
```

Then open <http://127.0.0.1:4199>. The server only listens on this Mac.

## What a run does

1. **Choose:** tick what to back up. Each row shows when it was last backed up.
2. **Drives:** the app lists the drives it needs and moves on once they're mounted. Drives are matched by volume UUID, not name.
3. **Review:** a dry run shows what would change. Nothing is copied here.
4. **Back up:** it runs and verifies each item, keeping the Mac awake.

You can close the page while it runs, because the server does the work, and reopen it to see progress. Keep the server running until the backup finishes. If a run is cancelled or interrupted, running it again picks up where it left off.

## How data is backed up

**Databases** use `mongodump --gzip`, written in full each run to `AtlasDBBackups/<date>/<database>` on every destination drive. A second run the same day uses `<date>-2`. Each dump is verified by counting the documents in the `.bson.gz` files and comparing them with the database. The last `retention` dumps are kept. Only dumps with a `backup-manifest.json` are ever pruned, so hand-made dumps and other databases in a dated folder are safe.

The connection string is read from the app's `.env` at run time, passed to `mongodump` through a temporary private file, and never stored.

**Files** use incremental rsync, and the backup mirrors the source exactly. Anything that would be overwritten or deleted is moved to `TedographyBackups/_replaced/<date>/<folder>`, where it stays until you delete it yourself. After copying, a second dry run confirms nothing still differs.

## Safety checks

- A backup can't be configured onto the same drive as its source.
- A source folder that's empty while its backup isn't blocks that item.
- If 5% or more of the files in a backup (and at least 20 files) would be replaced or deleted, you must confirm before the run can start. The thresholds are under `guard` in the config.
- A run needs a fresh plan less than 30 minutes old, and each plan can only be used once.
- Drives are rechecked by UUID before every item.
- The server refuses requests that don't come from its own page.

## Run records

Each run is saved to `~/Library/Application Support/backerUpper/runs` and to `BackerUpper/runs` on each drive used. The app reads both, so backup dates survive losing the Mac.

## Restoring

Restore a database with `mongorestore`, pointing it at a dated folder. Use a connection string with no database name, ending `mongodb.net/`, so nothing can default to the live database. The value in the app's `.env` ends in `/tedography`, so don't use it as is.

Rehearse on a scratch name first. This is the tested form:

```bash
mongorestore --uri 'mongodb+srv://USER:PASSWORD@HOST/' --gzip --stopOnError --nsInclude 'tedography.*' --nsFrom 'tedography.*' --nsTo 'tedography_scratch.*' --dir /Volumes/ShMedia/AtlasDBBackups/<date>
```

To restore over the real database, remove `--nsFrom` and `--nsTo`, and add `--drop` to replace existing collections. That has not been tested, and `--drop` discards what's there, so take a fresh dump first.

To remove a scratch copy, drop its collections one at a time. Atlas refused `dropDatabase` for this account.

Files are plain copies, so you can browse them in Finder and copy them back. Earlier versions are in `_replaced`.

## Adding an app

Add an entry to `apps` in the config, and any new drives to `volumes`. `type: "mongo"` items need the `.env` path, variable name and database. `type: "files"` items need a source and destination. Get a drive's UUID with `diskutil info /Volumes/<name>`.

## Development

```bash
pnpm dev
pnpm test
pnpm typecheck
```

`BACKERUPPER_CONFIG`, `BACKERUPPER_HISTORY_DIR` and `BACKERUPPER_PORT` override the defaults, which is how to test against disposable disk images instead of real drives.
