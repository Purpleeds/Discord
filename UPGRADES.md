# Upgrades

A log of the big version upgrades: what each one changed, what to check
after deploying it, and what should come next. Read this before starting
another upgrade so it builds on the last one instead of repeating it.
Day-to-day features are tracked in [ROADMAP.md](ROADMAP.md).

---

## Version 3.0 - Full (November 2026)

Theme: **a chat you can rely on.** Version 2 ended with a complete feature
set and a new look. The review for this upgrade found that the weak spots
were underneath: things people shared disappeared, the app forgot what
you hadn't read, logins were stored in the clear, and a dropped connection
failed silently.

### What changed

**Attachments that last**
- Every shared file used to be deleted after 6 hours, and sooner whenever
  the host restarted. Files up to 8 MB (`KEEP_FILE_MB`) are now stored in
  Postgres (`file_blobs`) and served from `/media/<key>/<name>`, so
  pictures in a chat stay.
- All kept files share a storage budget (`MEDIA_BUDGET_MB`, default 250).
  When it fills, files whose channel was deleted go first, then the oldest.
- Files over the limit are still temporary shares on disk (up to 10 GB,
  6 hours). The app now says so before sending and on the file itself,
  instead of letting them vanish.
- Large JPEG photos are resized in the browser before upload (longest side
  2560 px), which makes phone photos upload far faster and keeps them under
  the limit. Settings > Chat turns it off.
- Files can be deleted by whoever sent them or by a moderator.
- `/media` follows the same safety rules as `/uploads`: type from the file
  extension, pages and scripts download-only, SVGs sandboxed. It also
  answers byte-range requests, which Safari needs to play audio and video.

**Unread that survives**
- Unread badges used to exist only in the open tab. The server now works
  them out from read receipts (`GET /unread`), so they are right the moment
  the app opens, on any device.
- Reading a channel on one device clears its badge on the others
  (`readSync`). A tab left open in the background no longer marks things
  read; it waits until you look at it.
- A "New" line marks where you stopped reading, and the channel opens there
  when the new messages don't fit on screen.
- "Mark as read" on a server's menu. `POST /read-all` does one server or
  everything.
- History from before you joined a server or group never counts as unread,
  and nothing counted as unread on the day of the upgrade.

**Account security**
- Login sessions are stored as SHA-256 hashes, like bot and webhook tokens
  already were. Old sessions are hashed the first time they are used and in
  a sweep five minutes after boot, so nobody is signed out by the upgrade.
- Settings > Devices lists everywhere you are logged in and can sign any of
  them out. Changing your password still signs out every other device.
- Sessions now expire after 90 days without use, not 90 days after login.
- The login screen has separate "Log in" and "Create account" modes. A
  mistyped username used to silently create a new account; now it says
  there is no such account. Creating one asks for the password twice.
- Usernames that differ only by capitals can't be registered, and login
  ignores capitals.
- New passwords need 8 characters (existing shorter ones still work).
- The page sends a content security policy and can't be framed by another
  site. HTTPS visitors get HSTS.

**Connection resilience**
- A bar over the chat says when the connection is down. Messages sent
  meanwhile wait and go out on reconnect; before, pressing Enter did
  nothing.
- A message the server refuses (slowmode, muted) stays in place with the
  reason, "Try again" and "Discard".
- A device that was signed out, kicked or banned lands on the login screen
  instead of sitting dead; after a server restart the app reconnects on its
  own.
- Drafts: what you typed in a channel is still there when you come back,
  including after a reload.

**Speed**
- Opening a channel loads 75 messages instead of 300, with the files from
  the same stretch of time (`GET /history`). Scrolling up pages back through
  both together; they used to be fetched separately with different
  cut-offs.
- Search has a trigram index, so it no longer reads every message.
- The page is always revalidated, so a new release shows on the next visit.

**Tests**
- The regression suites that lived only in a scratch folder are now in
  `regression/` (see its README), next to tests for everything above.
  `npm test` covers the new server behaviour too.

### After deploying

- Nothing to migrate by hand. The schema changes are additive and run on
  boot.
- **Rolling back to version 2 signs everyone out** (it can't read hashed
  sessions). Kept attachments would also show as broken images there.
- Optional settings: `KEEP_FILE_MB` and `MEDIA_BUDGET_MB`. On Neon's free
  plan (0.5 GB for everything) the default 250 MB budget leaves room for
  messages; raise it on a bigger plan.
- Worth testing by hand: log in on a phone and a laptop and check badges
  clear on both; send a photo from a phone; turn wifi off and on mid-chat;
  sign the phone out from Settings > Devices.

### Not done, on purpose

- `server.js` and `public/index.html` are still one file each. Splitting
  them was weighed against the work above and lost; it is first on the
  list below.
- The browser tab still says "Google" with Google's icon, as it did before
  this upgrade. Giving the app its own name and icon is the owner's call.

### Top ideas for the next upgrade

1. **Split the two big files.** `server.js` (about 5,800 lines) into
   modules by area (auth, rooms and access, messages, files, calls, bots),
   and the client's script and styles out of `index.html`. The regression
   suites in `regression/` now make that safe to attempt. Once scripts are
   out of the page, the content security policy can drop `'unsafe-inline'`
   and become a real XSS barrier.
2. **Merge files into messages.** Attachments are separate timeline items
   with their own table, which is why they can't be replied to, reacted to,
   pinned, searched or sent several at once under one caption. Making an
   attachment part of a message fixes all of that.
3. **Mention-aware badges.** The server already returns how many unread
   messages mention you. Use it: a quiet dot for ordinary unread, a number
   only for mentions and DMs.
4. **External file storage.** An S3-compatible bucket (Cloudflare R2,
   Backblaze B2) for attachments, so the 8 MB / 250 MB limits can go and
   large files stop being temporary.
5. **Account recovery and two-step login.** There is no way back into an
   account after a forgotten password. Recovery codes, an admin-issued
   reset link, and optional TOTP.
6. **Server moderation tools.** An audit log (who deleted, kicked, changed
   roles), per-server timeouts and bans; today bans are site-wide only.
7. **A TURN relay for calls** on networks that block direct connections
   (still open from version 2).
