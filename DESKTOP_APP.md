# Desktop app (.exe) - plan

A Windows app for the chat, so it can do what a website can't: its own
Steam/Teams-style pop-ups on the desktop, a tray icon, start with Windows,
push-to-talk while you're in a game, and a proper screen-share picker.

## Option A (William's pick to start with): a background notifier only

No chat window at all - a small program that sits in the tray, stays
connected, and shows Steam/Teams-style pop-ups on the desktop. Clicking a
pop-up opens the chat **in your normal browser** at that message (`/#m/<id>`).

- **What it does:** log in once (the login is kept with Windows' own
  encryption via `safeStorage`), connect like a browser tab does, and show a
  pop-up card (picture circle, name, where, rounded message box - same design
  as the in-app cards) for messages that would ping you. Tray menu: Open chat,
  Do Not Disturb, Mute for 1 hour, Start with Windows, Sign out, Quit.
- **Server changes:** the notifier connects as a "background" device, so it
  doesn't make you look online, and the server still sends phone pushes as if
  you were away. It only gets message summaries (who, where, short text,
  picture), never whole histories.
- **Which messages:** DMs, group chats, @mentions, plus anything your
  per-channel settings say "All messages" for. Do Not Disturb is respected.
  When a chat tab is already open and in front, the notifier stays quiet.
- **Size:** built with **Tauri** (~8-10 MB, uses Windows' built-in WebView2)
  since it's just a tray icon and pop-up windows. Electron would also work but
  is ~90 MB for the same thing.
- **Effort:** about 1-2 sessions, including the installer and auto-update
  (phase 4 below applies the same way).
- **Later:** it can grow into the full app (Option B) - the pop-up design and
  installer carry over.

## Option B: a thin Electron shell around the live chat

The app is a small window that loads the real chat (the same address as the
website). All the chat code stays in `public/index.html` and the server, so
every merge reaches the app the moment it restarts - no new .exe needed for
chat features. The .exe only changes when the shell itself does.

**Why Electron** (not Tauri, not "just install the PWA"):

| | Electron | Tauri | Installed PWA (have today) |
|---|---|---|---|
| Custom pop-ups on the desktop | yes (own little windows) | yes | no - Windows draws them |
| Push-to-talk while another app is focused | yes (global keys) | yes, with a plugin | no |
| Screen-share picker (pick a window) | built in (`desktopCapturer`) | harder | browser's own picker |
| Calls (WebRTC) | Chromium - same as Chrome | WebView2 - fine | fine |
| Download size | ~90 MB | ~10 MB | none |
| Language | JavaScript, like the rest of the app | Rust + JS | - |

Electron wins on "everything is JavaScript and calls behave exactly like
Chrome". Tauri is the fallback if the download size ever matters.

## Phases

### 1. The shell - `low`/`medium`
- New folder `desktop/` with `main.js`, `preload.js`, `package.json`
  (Electron + electron-builder). Nothing in it is loaded by the server.
- One window, remembers its size/position; only one copy runs at a time
  (opening it again focuses the existing one).
- Loads `CHAT_URL` (default: the onrender address). Links to other sites
  open in the normal browser; the window can never navigate away from the chat.
- Security settings: `contextIsolation`, `sandbox`, no Node in the page; the
  page only gets a tiny `window.chatDesktop` API from `preload.js`.
- Tray icon (Open / Do Not Disturb / Quit), closing the window hides to tray,
  optional "Start with Windows".

### 2. Custom desktop pop-ups - `medium`
- The web app checks for `window.chatDesktop`; when it's there it sends
  `chatDesktop.notify({ name, where, text, tags, avatar, messageId })`
  instead of `new Notification(...)` - same mute / Do Not Disturb rules as now.
- The shell shows the same card design as the in-app pop-ups (picture
  circle, name, where, rounded message box) in a small frameless,
  always-on-top window above the taskbar, bottom-right. Up to 3 stacked,
  6.5 s each, hover holds, click opens the app at that message (`/#m/<id>`).
- The card always names the app ("Chat") and the channel/DM - same honesty
  rule as every notification (CLAUDE.md).
- Taskbar: red unread badge on the icon, flash the button on a mention/DM.

### 3. Gaming extras - `medium`/`high`
- Global push-to-talk key (works while a game is focused) - Settings > Voice
  gets a "Desktop app: global key" option when `chatDesktop` exists.
- Screen share: the shell shows its own picker (screens and windows with
  thumbnails, "share audio" tick) via `desktopCapturer`.
- Optional: "Playing <game>" status from the window title of the focused app
  - only if wanted, off by default (privacy).

### 4. Installer + updates - `medium`
- `electron-builder` makes `Chat-Setup-x.y.z.exe` (NSIS installer: Start-menu
  shortcut, uninstaller) and a portable `.exe`.
- A GitHub Actions workflow builds it on `windows-latest` whenever a
  `desktop-v*` tag is pushed and attaches it to a GitHub Release.
- Auto-update with `electron-updater` from those releases (checks on start
  and every few hours, installs on next quit).
- **Code signing:** without a certificate Windows SmartScreen says "Windows
  protected your PC" the first few times (More info > Run anyway). A signing
  certificate removes that but costs money each year - fine to skip for
  friends.
- macOS/Linux builds can be added to the same workflow later.

## What William needs to decide / do
1. App name and icon (default: "Chat" with the existing chat-bubble icon).
2. Which address it opens (default: https://discords-zf2n.onrender.com).
3. Nothing to install locally: GitHub builds the .exe. Download it from the
   repo's Releases page.

## Tests
- `desktop/` gets a smoke test with Playwright's Electron support: the
  window opens the chat, external links don't navigate it, `chatDesktop`
  only exposes the listed functions, a fake `notify` shows a card.
- The web app's regression suites keep passing without `chatDesktop` (the
  browser path is unchanged).

Effort overall: about 3-4 sessions (phase 1+2 in one, 3 in one, 4 in one,
then fixes after William tries it).
