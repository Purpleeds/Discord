# Chat Notifier (Windows)

A small tray program that shows the chat's pop-up cards on the desktop -
picture, name, where it was sent, and the message - while the chat itself
isn't open in front of you. Clicking a card opens that message in your
normal browser. There's no chat window in it.

## Using it

1. Download `Chat-Notifier-Setup-<version>.exe` from the repo's **Releases**
   page (the `notifier-v…` ones) and run it. If Windows says "Windows
   protected your PC", click **More info → Run anyway** (the app isn't
   code-signed).
2. Sign in with your chat username and password. The address is filled in
   (`https://discords-zf2n.onrender.com`); at home you can use the NAS address.
3. That's it - it sits in the tray (bottom-right, maybe under the `^`) and
   starts with Windows. Right-click the icon for: open the chat, settings,
   "pop up for" (DMs/groups/@mentions, or every message), pause for 1 or 8
   hours, Do Not Disturb, a test pop-up, start with Windows, sign out, quit.

It stays quiet while the chat is open and focused in a browser (that shows
its own pop-ups), while you're on Do Not Disturb or paused, and for people
you've blocked. It never makes you look online. While it's running, the chat
in your browser leaves desktop notifications to it, so nothing shows twice.
It appears as **Chat Notifier on Windows** in the chat's Settings > Devices,
where you can also sign it out.

**How long pop-ups stay:** Settings > Pop-ups (or the tray's "Pop-ups stay
for"): 4, 6.5 (default), 10 or 20 seconds, or until you close them. Hovering
always holds a card.

**Updates (from 1.1.0):** the installed app updates itself - it downloads a
new release in the background, says so with a pop-up, and installs it when
the app next closes, or right away with "Restart to update" (pop-up, tray or
Settings). Turn it off with Settings > Update automatically. The portable
.exe can't replace itself, so it offers the download instead. (1.0.0 has no
auto-update: install 1.1.0 by hand once.)

**Can't connect?** Settings shows the reason next to "Can't reach the chat".
The notifier trusts the same certificates as your browser (Windows' own list),
so antivirus HTTPS scanning doesn't block it, and it falls back to plain
requests where WebSockets are blocked (since 1.1.1).

## How it works

- `main.js` - the tray, the sign-in, one Socket.IO connection to the chat as a
  *background* device (`auth: { background: true }`), and the pop-up windows
  (frameless, always on top, never take focus; at most 3, newest at the
  bottom; same person + place = one card with "2 new").
- `lib/logic.js` - what pops up and what it says (pure functions, tested in
  `test/logic.test.js`).
- `ui/` - the card and the settings window. Both are sandboxed pages with no
  Node access; they only talk to `main.js` through their small preload APIs,
  and all message text is set with `textContent`.
- The sign-in is kept encrypted with Windows' own data protection
  (`safeStorage`), in `%APPDATA%\Chat Notifier\config.json`.

Server side (`server.js`): background sockets get the same live events as a
tab but aren't counted as online (presence, push); tabs report whether
they're open and focused (`appVisible`), the notifier is told (`foreground`),
and tabs are told a notifier runs (`notifier`).

## Developing

```
cd desktop
npm install
npm start                       # runs it from source
npm test                        # logic tests
npm run dist                    # Windows build (needs Windows, or Wine)
```

The end-to-end test drives the real app against its own chat server:
`node regression/notifier_ui.test.js` from the repo root (needs Postgres, and
Xvfb on Linux - see regression/README.md). It's also in `regression/run.sh`.
`NOTIFIER_EXE=desktop/dist/linux-unpacked/chat-notifier` runs it against a
packaged build (`npx electron-builder --linux dir`).

**Releases** are built by GitHub Actions on Windows
(`.github/workflows/notifier.yml`): every PR that touches `desktop/` builds
the installer and starts the built .exe as a smoke test. To publish: bump
`version` in `package.json`, merge, then Actions → *Chat Notifier (Windows)* →
Run workflow (release ticked). That creates the `notifier-v<version>` release,
marked latest, with `latest.yml`: installed copies (electron-updater, generic
feed `releases/latest/download`) pick it up within a few hours.
