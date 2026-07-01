# Background Mode v2 — Design & Behavior

Re-implementation of the card's background mode with fail-safes and a minimized dock UI on
the Home Assistant frontend. Companion documents: [routine-event-pathways.md](routine-event-pathways.md)
(pre-existing behavior spec) and [standards-audit.md](standards-audit.md) (the Chromium/MDN
sequence & event audit that motivated several of the fail-safes).

---

## 1. What background mode does

Pinning a card (the `mdi:pin` step in the volume-icon cycle, unchanged) keeps its audio
streaming after the card leaves the screen — other dashboard view, minimized app, phone
screen off. One hidden card (the **designated background card**) stays attached to the
shared session and keeps the WebRTC call and `<video>` element alive.

New in v2, while a background session is active and its card is **not** visible, a minimized
**dock** appears bottom-center on the HA frontend:

- **Collapsed chip**: pin glyph + camera name (or count) + a worst-state dot.
- **Expanded panel** (tap the chip): one row per background session with its live state and
  two actions — **return** (navigate back to the card's dashboard view) and **close** (a
  *soft* close: audio stops immediately, but the stream holder stays attached through the
  5-second UNDO window so UNDO genuinely resumes it; after the window the close commits as
  a full unpin).
- A row in the *audio blocked* state turns the tap itself into the autoplay-unmute gesture.
- After a page reload with no card on the current view, pinned sessions appear as
  *suspended* chips — tap to reopen ("wait-for-card" resume; audio can never legally
  autoplay on a fresh page load without a gesture, so a deliberately silent auto-resume
  would violate "never lose audio silently").

The dock never plays sound, never shifts layout (fixed overlay, safe-area aware), is
suppressed while anything is fullscreen, and honors `prefers-reduced-motion`.

## 2. Components

| Piece | Role |
|---|---|
| `BackgroundManager` (singleton on the top window) | Persistent registry, migration + GC, cross-tab lease/claim protocol, page-lifecycle handlers, hidden-tab worker ticker, MediaSession, dock lifecycle. |
| `<webrtc-babycam-dock>` (appended to `document.body`) | The minimized UI. Renders purely from `manager.snapshot()`; failures are isolated from session code. |
| `WebRTCsession` additions | `state.backgroundCard` designee + `claimBackground()`/`releaseBackground()`; `park()`/`unpark()`/`evaluateBackground()`; `kick()`; starvation-aware watchdog; `endCallFast()`; audio-only video shedding. |

## 3. Persistence (schema v2)

One localStorage JSON key — `webrtc.background.v2`:

```json
{ "v": 2, "sessions": { "<session-key>": {
    "enabled": true,
    "entity": "camera.nursery",
    "friendlyName": "Nursery Cam",
    "returnPath": "/lovelace/babycam",
    "lastAliveAt": 1751312345678,
    "startedAt": 1751300000000
} } }
```

- Legacy `webrtc.<key>.background` strings are migrated once (both `true` and `false`
  polarities — a stored `false` must keep overriding `background: true` config) and removed.
- `returnPath` is captured at pin time and refreshed at every last-visible moment, so
  "return" goes where the user actually was.
- Garbage collection reaps entries unseen for 30 days (14 for unclaimed legacy imports), and
  a config edit that changes the session key **migrates** the pin to the new key instead of
  silently losing it (same entity + same dashboard + stale lease).
- All storage access is wrapped (`safeStorage`): storage-denied environments degrade to
  session-lifetime, in-memory behavior instead of throwing inside `attachCard`.

## 4. Fail-safes

| Failure | Mechanism |
|---|---|
| Two tabs both streaming the same camera hidden | `claim` broadcast (BroadcastChannel + storage-event fallback — both work on plain-http HA; Web Locks does not) with deterministic tabId tie-break; visible cards are exempt (multi-viewer stays legitimate). |
| Background disabled in one tab, another tab streams on (orphan) | `set-enabled` messages + `storage` listener + periodic `reconcileSessions()` unwind the hidden designee everywhere. |
| Tab crash while holding the stream | `lastAliveAt` lease heartbeat (15 s, worker-driven while hidden) goes stale in 90 s → other tabs / next load show a *suspended* chip. |
| Autoplay-blocked background audio (muted stream burning bandwidth all night) | `park('muted')` after `background_muted_grace` (default 60 s): call stops, snapshot loop continues, dock shows *Audio blocked — tap to enable*; the dock tap is the unmute gesture. Opt out with `background_mute_policy: keep`. |
| Hidden-tab timer throttling starving the 1 s watchdog (Chromium intensive throttling = 1 timer/min during reconnect gaps) | Starvation-aware deadline (a healthy call with recent media activity is never torn down just because ticks starved), same-tick restart, and a dedicated-Worker ticker (immune to throttling) that kicks an overdue watchdog every 5 s while a hidden background stream is held. |
| bfcache / freeze / pagehide | Transports closed synchronously (`endCallFast` — the old teardown awaited a network fetch, which never completes in pagehide); lease released; `pageshow(persisted)`/`resume` re-claim and kick an immediate reconnect. |
| Unwatched video decoded/transferred all night | Background calls negotiate **audio-only** (`background_video: shed`, default); video restored on return; auto-fallback to `keep` after 2 consecutive failed audio-only offers. |
| Forgotten pin | Optional `background_timeout` (minutes, default 0 = off) parks the stream — loudly, resumable from the dock — counted from last user interaction. |
| Accidental close at 3 a.m. | 5-second UNDO strip instead of a confirm dialog. |
| Dead sessions from destroyed same-origin iframe documents | `getInstance()` discards dead-realm/terminated registry entries. |
| OS media controls | MediaSession metadata + handlers while background audio is audible: lock-screen *pause* parks (resumable), *play* unparks with real user activation. |

## 5. Config surface (all optional; defaults preserve existing behavior except `background_video`)

```yaml
background: false              # unchanged — enables background mode by default
allow_background: false        # unchanged — allows the pin toggle in the volume cycle
background_muted_grace: 60000  # ms muted+hidden before parking
background_mute_policy: park   # park | keep   (keep = stream on muted forever, old behavior)
background_video: shed         # shed | keep   (shed = audio-only offers while hidden)
background_timeout: 0          # minutes, 0 = off
dock: true                     # false hides this session from the dock (kiosk escape hatch)
```

## 6. Known platform limits (documented, not solvable in JS)

- iOS Safari / the companion-app WKWebView suspends page JS and WebRTC playback shortly
  after backgrounding unless audio is audibly playing. The lease + registry turn that into a
  *suspended* dock chip on return rather than silent loss.
- A fresh page load has no user activation, so resumed background audio cannot legally
  autoplay unmuted; the suspended chip's tap supplies the gesture.
