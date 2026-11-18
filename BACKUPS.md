# Backups, restore and data export

The chat backs itself up: the whole database (accounts, servers, messages,
DMs, settings, kept files) **and** the files it keeps on disk (big
attachments, big banners and videos). It's in `backup.js`, turned on by
`BACKUP_DIR`, which the NAS setup (`deploy/nas/docker-compose.yml`) sets.

## What you get

- **A backup every day** (`BACKUP_EVERY_HOURS`, default 24), the first one a
  couple of minutes after the chat starts. Each one is a consistent picture,
  even while people are chatting.
- **Kept:** the newest 7, then one a week for 8 weeks and one a month for 12
  months (`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_MONTHLY`).
  Files are stored once, by their contents, so a daily backup only adds
  what's new since the day before.
- **Settings > Backups** (only Purple, the site owner, sees it): when the
  last one ran, free disk space, **Back up now**, and for each backup
  **Download** (one `.tar` file) and **Restore**.
- **Restore** puts everything back as it was at that backup. It saves the
  current data as a backup first ("Saved before a restore"), so a restore
  can itself be undone. The chat restarts afterwards and everyone
  reconnects; anyone who signed in after that backup signs in again.
- **A new or wiped database restores itself:** if the chat starts on an
  empty database and finds backups in `BACKUP_DIR`, it restores the newest
  one before anything else (turn off with `BACKUP_RESTORE_IF_EMPTY=off`).
  On the NAS, the one-time Neon copy is skipped when backups exist, so old
  Neon data never wins over your backups.
- **Download my data** (Settings > Privacy & Safety, everyone): a zip of
  their account and profiles, servers, friends, blocks, devices, every
  message they sent (with where), their reactions and the files and pictures
  they uploaded. No password or login hashes, and not other people's
  messages.
- **Export channel** (right-click a channel; needs the Manage messages power):
  a zip with `messages.json`, a readable `messages.html`, the channel's
  threads, and its attachments. Logged in the server's audit log.

Downloads use a single-use link that lasts 10 minutes, so big files go
straight to the browser's downloads.

## Setup on the NAS (needs William)

The compose file already turns backups on into a `backups` folder next to
the project. That protects against mistakes (a bad update, deleted
messages), **but not against losing the disk**, because the backups are on
the same disk as the chat. To be safe, do one of these, best first:

1. **Copy the backup folder off the NAS automatically.** Both NAS makers have
   a free app for this that encrypts and uploads a folder on a schedule:
   - Synology: **Hyper Backup** (or **Cloud Sync**) > back up the project's
     `backups` folder to Google Drive, OneDrive, Synology C2, Backblaze B2
     or a USB drive. Daily, after 04:00.
   - UGREEN: **Sync & Backup** > back up the `backups` folder to a cloud
     drive or a USB drive.
   Turn on the app's encryption: the backups contain every DM.
2. **Point the backups at a second disk or a USB drive.** In
   `docker-compose.yml`, change `./backups` (in **both** places: the
   `import` and `chat` services) to a folder on the other disk, for example
   `/volume2/chat-backups` (look up the real path in the NAS's file manager > folder > Properties).
   Then re-create the project.
3. **Now and then, download one by hand:** Settings > Backups > Download,
   and keep the `.tar` on your PC or a cloud drive.

After changing the compose file, open Settings > Backups in the chat and
press **Back up now** once to check it works.

### If the NAS disk dies

1. Set up the chat again from `deploy/nas/README.md`.
2. Put the backup folder back where `docker-compose.yml` expects it: restore
   it with Hyper Backup / Sync & Backup, or extract a downloaded `.tar`
   into it (you should see `snapshots` and `blobs` folders inside).
3. Start the project. The `chat` log says
   `the database is empty and /backups has backups - restoring ...`, and the
   chat comes back as of that backup.

## How it works (for whoever changes the code)

- `BACKUP_DIR/snapshots/<id>/manifest.json` + one `<table>.ndjson.gz` per
  table; `BACKUP_DIR/blobs/<ab>/<sha256>` holds file bytes and big `bytea`
  values (kept attachments, assets). A snapshot is written as
  `<id>.partial` and renamed when complete; leftovers are deleted at start.
- Every table in the schema is included automatically, so **new tables and
  columns need no backup changes**. Rows are dumped with `to_jsonb()` in one
  `REPEATABLE READ` transaction and restored with
  `jsonb_populate_recordset()` into the columns the backup and the current
  schema share, so an older backup restores into a newer schema (new columns
  keep their defaults). Counters (`SERIAL`) never go backwards, so ids are
  never reused after a restore.
- Restore checks every piece is present before touching anything, truncates
  and refills all tables in one transaction, writes the disk files back,
  then the server restarts (Docker brings it back; caches and live sockets
  belong to the old data).
- `regression/backups.test.js` covers all of it, including a restore into a
  brand-new database and a schema with an extra column.
