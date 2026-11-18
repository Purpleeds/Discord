# Chat Notifier (Windows) - the chat app

The chat for Windows (from 2.0.0): the chat in **its own window**, with
**push to talk that works while a game is in front**, **its own
screen-share picker** (a whole screen or one window, optionally with the
computer's sound), a taskbar badge, and the desktop pop-up cards it always
had - picture, name, where it was sent, and the message - while the chat
isn't in front of you. It keeps running in the tray when the window is
closed (calls keep going), and updates itself.

The window is the live chat website, so every chat feature arrives the
moment the server updates - a new .exe is only needed when the app itself
changes. Settings > General > *Open the chat in* can send it to your normal
browser instead (the old "notifier only" behaviour).

## Using it

1. Download `Chat-Notifier-Setup-<version>.exe` from the repo's **Releases**
   page (the `notifier-v…` ones) and run it. If Windows says "Windows
   protected your PC", click **More info → Run anyway** (the app isn't
   code-signed).
2. The chat opens in the app's window: log in there as usual. Pop-ups use
   that same sign-in by themselves (it's one device on the Devices page).
   Or sign in from the tray's settings window with your chat username and password. The address is filled in
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

**The window** (click the tray icon) has three pages: *Pop-ups* (what pops
up, how long it stays, pause), *Appearance* and *General* (start with Windows,
updates, sign out, the log).

**Themes (from 1.2.0):** the chat's four looks, plus your own - *New theme*
picks a background, message box, text and secondary text colour with the
built-in colour picker (drag the square and hue bar, type a hex code, use the
eyedropper to take a colour from anywhere on screen, or pick a preset/recent
colour). It warns when text would be hard to read, and the preview shows the
draft before you save. Click your chosen theme again to edit or delete it.
The accent colour (presets or any colour) applies to every theme. Up to 12
themes of your own, kept in `config.json`; colours are checked in the main
process (`cleanCustomTheme()` in `lib/logic.js`), which also works out the
other shades (`themeTokens()`).

**How long pop-ups stay:** Settings > Pop-ups (or the tray's "Pop-ups stay
for"): 4, 6.5 (default), 10 or 20 seconds, or until you close them. Hovering
always holds a card.

**Updates (from 1.1.0):** the installed app updates itself - it downloads a
new release in the background, says so with a pop-up, and installs it when
the app next closes, or right away with "Restart to update" (pop-up, tray or
Settings). Turn it off with Settings > Update automatically. The portable
.exe can't replace itself, so it offers the download instead. (1.0.0 has no
auto-update: install 1.1.0 by hand once.)

**Doesn't open / can't connect?** The app keeps a log at
`%APPDATA%\Chat Notifier\notifier.log` (start-up, connecting, updates, crashes -
never passwords or messages); Settings > General > *Show the log* opens its
folder. If something in the app itself goes wrong it says so in a box instead
of quietly vanishing. Settings shows the reason next to "Can't reach the chat".
The notifier trusts the same certificates as your browser (Windows' own list),
so antivirus HTTPS scanning doesn't block it, and it falls back to plain
requests where WebSockets are blocked (since 1.1.1).

## The chat window

- **One sign-in.** Logging in to the window turns the pop-ups on (main.js
  `linkFromChatWindow()` reads the page's login once and keeps it encrypted
  like a normal sign-in). *Sign out* (tray or settings) signs the window and
  the pop-ups out together and ends that login on the server.
- **Push to talk everywhere.** Settings > Voice > Push to Talk in the chat:
  the key (or the middle / a side mouse button) works while any app or game
  is in front. The app uses a low-level keyboard/mouse hook (`uiohook-napi`)
  only during a call in push-to-talk mode, and only reports "pressed" /
  "released" of that one key to the page - no other key is looked at or kept.
  Games running as administrator can hide keys from non-admin programs; run
  both the same way if the key doesn't work in one.
- **Screen share picker.** Share Screen in a call opens the app's own picker:
  Screens / Windows tabs with live thumbnails, and *Also share my computer's
  sound* (Windows only; it sends everything the PC plays, so the people in
  the call may hear themselves if Windows can't keep the call's own sound out).
- **Badge + flash.** A red dot on the taskbar button while there's something
  unread, and the button flashes for messages that would alert you.
- **Stays the chat.** Links to other sites open in your browser; the window
  can't navigate anywhere else, the page has no Node access and only gets a
  small `window.chatDesktop` (`ui/chat-preload.js`): `pushToTalk`,
  `onPushToTalk`, `setUnread`. Camera/mic/notification permissions are only
  given to the chat's own address. Its login lives in its own storage
  (`persist:chat` partition). Shows as **Chat app on Windows** in Devices.
- Closing the window hides it to the tray (once, a card says so); Quit is
  in the tray menu. The window remembers its size and place. If the chat
  can't be reached (Render waking up, an update) it shows a small "trying
  again" page and retries every 5 seconds.
- Ctrl+R / F5 reloads, Ctrl+Shift+I opens the developer tools.

## Microsoft Store version

The same app is also built as a Store package (`.appx`, electron-builder's
`appx` target, `build.appx` in package.json). The Store signs it, so there's
no SmartScreen warning. Differences in that version (`process.windowsStore`,
or `CHAT_NOTIFIER_STORE=1` to try it from source):

- **Updates** come from the Store; the built-in updater and the GitHub
  update check are off.
- **Start with Windows** is a startup task in the package (on by default);
  people switch it in Windows Settings > Apps > Startup, which the app's
  General page and tray link to.
- Windows starts it at sign-in without `--hidden`, so a signed-in start shows
  a small "running in the tray" card instead of the window. Opening it again
  shows the window.
- Its settings and log live in the package's folder
  (`%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\Chat Notifier`).

**Publishing:** in Partner Center, reserve the app name, then copy *Product
identity* (Package/Identity Name, Publisher `CN=…`, Publisher display name)
into the repo's Actions variables `MSSTORE_IDENTITY_NAME`, `MSSTORE_PUBLISHER`,
`MSSTORE_PUBLISHER_NAME`. Every CI run then builds a matching
`Chat-Notifier-<version>-store.appx` (artifact `chat-notifier-store-<version>`)
- upload that file in the submission's Packages step. CI also installs a
test-signed copy and starts it (`test/store-test.ps1`). Tile images are in
`assets/appx/`. When submitting, the `runFullTrust` capability needs a short
reason: "Desktop (Electron) app: tray icon and desktop notifications."

## How it works

- `main.js` - the tray, the sign-in, one Socket.IO connection to the chat as a
  *background* device (`auth: { background: true }`), and the pop-up windows
  (frameless, always on top, never take focus; at most 3, newest at the
  bottom; same person + place = one card with "2 new").
- `lib/logic.js` - what pops up and what it says (pure functions, tested in
  `test/logic.test.js`).
- `lib/desktop.js` - the chat window's rules: which addresses stay in it, the
  push-to-talk key codes, saved window places, the picker list (tested in
  `test/desktop.test.js`).
- `ui/` - the card, the settings window and its colour picker (`picker.js`); the
  fonts (Figtree, Bricolage Grotesque - OFL, `ui/fonts/`) are bundled. The pages are sandboxed with no
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
npm test                        # logic tests (pop-ups + chat window)
npm run dist                    # Windows build (needs Windows, or Wine)
```

`test/install-test.ps1` installs the built installer on Windows the way people
do (double-click five times over, the portable .exe, start by hand, start at
sign-in, and an update from 1.1.0 the way the app updates itself) and checks
the window really appears each time - CI runs it on every build. It's why the
build uses electron-builder's NSIS 3.12 bundle (`build.toolsets.nsis`): the
default NSIS 3.0.4 installer crashed at random when double-clicked on Windows
11 24H2 / build 26100 (access violation in `System.dll`, nothing installed) -
the "it doesn't open" of 1.1.x. Don't go back to the default toolset.

`build.npmRebuild` is off on purpose: the only native module, `uiohook-napi`,
ships N-API prebuilds (`prebuilds/win32-x64`) that work in any Electron, so
nothing is compiled during the build. `test/smoke-packaged.js` checks on
Windows that the packaged hook loads and hears a key.

The end-to-end tests drive the real app against its own chat server -
`node regression/desktop_app.test.js` for the chat window, and
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
