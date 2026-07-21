# Manual Testing Checklist

Live-browser verification for the background-mode v2 rework and the standards-audit
remediation. Nothing in these changes has run in a browser yet — this list is ordered so
the highest-risk changes are exercised first.

## Setup

1. Install/update `custom_components/babycam`, restart Home Assistant, and confirm
   `/babycam/webrtc-babycam.js?v=2026.7.2` is the only Babycam dashboard resource
   (or hard-reload with DevTools open and "Disable cache" checked).
2. Confirm the load: the console banner must read `WebRTC Babycam v2026.7.2`.
3. Enable tracing: append `?debug` to the dashboard URL, or press `Shift+D` on the
   dashboard. The overlay's first line shows `webrtc-babycam v2026.7.2` — if the version
   is missing or old, you are testing cached code; stop and fix that first.
4. Useful trace lines referenced below: `STATE <status>`, `Background parked: <reason>`,
   `Background unparked`, `Play watchdog starved <n>ms`, `Holding background stream as
   designated card`, `Live via stats fallback`, `Audio-only offers failing`.

Suggested card config for most tests:

```yaml
type: custom:webrtc-babycam
entity: camera.<your_cam>
allow_background: true
debug: true
```

## 1. Core regression (nothing here should have changed)

| # | Steps | Expect |
|---|-------|--------|
| 1.1 | Open the dashboard with the card visible | Snapshot appears first, video within a few seconds, live dot pulsing |
| 1.2 | Unplug/block the camera for ~30 s, restore | Card degrades to (blurring) snapshot, reconnects by itself, no permanent error state |
| 1.3 | Tap the video once | No pause; stream continues (auto-resume) |
| 1.4 | Volume cycle: tap volume icon repeatedly | mute → unmute → pin (background) → unpin+mute, exactly as before |
| 1.5 | Two-way audio (if configured): mic toggle | Call restarts with/without uplink |

## 2. MediaStream liveness (highest-risk change — `timeupdate` no longer feeds the freeze detector)

| # | Steps | Expect |
|---|-------|--------|
| 2.1 | Normal playback, video card, watch 2+ min | Live dot stays on; **no spurious stale/blur** while frames flow |
| 2.2 | Audio-only card (`video: false`), watch 2+ min | White live dot stays on (trace shows `Live via stats fallback (audio packets=…)` on engines without other signals) |
| 2.3 | Freeze the source while keeping the connection up (e.g. pause the ffmpeg/go2rtc input, or `tc`/firewall RTP only) | Video blurs within `image_expiry` (~15 s), snapshot polling resumes; audio-only variant: dot fades — a dead stream must NOT show a live dot |
| 2.4 | Same as 2.3 on Safari (if available) | Same behavior (Safari lacks some stats fields; packet counter is the fallback) |

## 3. Background mode + dock

| # | Steps | Expect |
|---|-------|--------|
| 3.1 | Pin the card (volume cycle), navigate to another view | Trace `Holding background stream as designated card`; audio continues; dock pill appears bottom-center within ~1 s |
| 3.2 | Tap the pill → expand | Row with friendly name + "Live audio · tap to open"; green pulsing dot |
| 3.3 | Row tap (or open icon) | Navigates back to the camera's view; card attaches; pill disappears |
| 3.4 | Navigate away again → dock → **close (×)** | Audio stops immediately; row becomes "… stopped · UNDO" |
| 3.5 | Tap UNDO within 5 s | **Audio genuinely resumes** (same stream, no reload) |
| 3.6 | Close again, let 5 s pass | Pin is cleared (registry unpinned); pill disappears; revisiting the card shows it unpinned |
| 3.7 | Video shedding: pin an audio+video card, hide it, check go2rtc/server stats or `chrome://webrtc-internals` | Background call renegotiates **audio-only** (trace `Background: video shed from offer`); returning to the view restores video (brief blip covered by snapshot) |
| 3.8 | Reload the browser onto a *different* view with a pin active | Dock shows a grey **suspended** chip "Tap to open"; tap → navigates, card attaches, audio resumes (tap doubles as the unmute gesture) |
| 3.9 | Autoplay-block park: with the pin on, reload onto the pinned view and **touch nothing**, then navigate away (or reload onto another view and wait) | After ~60 s trace `Background parked: muted`; dock row turns amber "Audio blocked — tap to enable"; tapping the row unmutes and resumes |
| 3.10 | Lock screen / OS media controls (Android Chrome, desktop): while background audio is audible | Media notification shows the camera name; **pause** parks the stream (dock shows paused), **play** resumes it |

## 4. Multi-tab fail-safes

| # | Steps | Expect |
|---|-------|--------|
| 4.1 | Two tabs on the pinned camera's view, hide both | Only ONE tab streams (check webrtc-internals in both); no doubled audio |
| 4.2 | Unpin (or dock-close) in tab B | Tab A's hidden stream stops too — no orphan (watch A's trace) |
| 4.3 | Kill the streaming tab (Task Manager, not close) | Within ~90 s the other tab's dock flips the chip to suspended/reopenable |
| 4.4 | Tab A hidden-streaming, tab B has the card VISIBLE, then hide B | B takes over (visible viewer wins); A releases; still exactly one stream |

## 5. Lifecycle & throttling

| # | Steps | Expect |
|---|-------|--------|
| 5.1 | Background-pin, hide the tab >6 min (Chrome), briefly break the camera mid-way | Reconnect still happens on a ~5 s cadence (worker ticker), not once a minute; on refocus, **no teardown of a healthy stream** (trace may show `Play watchdog starved …; extending deadline`) |
| 5.2 | Open the dashboard in a background tab (middle-click), don't focus it | No stream starts (check webrtc-internals); focusing the tab attaches normally |
| 5.3 | Navigate browser back/forward across the dashboard | Streams recover promptly; no dead black cards |
| 5.4 | Edit the pinned card's config (e.g. change `image_interval`) while its view is NOT the active one, then save | Background audio survives the reconfigure; pin intact (trace shows re-arm) |
| 5.5 | Edit a *visible* card's config and save | Card re-renders and reattaches — no permanent black card |

## 6. Audit-fix spot checks

| # | Steps | Expect |
|---|-------|--------|
| 6.1 | Type `T`, `D`, `S` (with Shift) into any HA text field (entity search, card editor) | Nothing toggles — no global mute flips, no debug overlay |
| 6.2 | PTZ: press-and-hold an arrow ~3 s, release, spam-press repeatedly | Repeats at a steady cadence while held; stops instantly on release; NO continued service calls afterwards (watch HA's service log) |
| 6.3 | Hold the snapshot ~1 s, release, tap once quickly | Snapshot refreshes; **no fullscreen** jump |
| 6.4 | Double-tap / double-click the card | Fullscreen toggles on AND off; on iPhone: native video fullscreen opens |
| 6.5 | Scroll the card in/out of view repeatedly, switch views rapidly | Streams attach/detach cleanly; session survives quick churn (3 s grace); no console errors |
| 6.6 | WHEP (if you use `url_type: whep` / MediaMTX): connect, then check the server's session list after a few reconnects | No accumulating zombie sessions (DELETE is sent); trickle PATCHes hit the per-session URL |

## 7. Platform passes (as available)

- **iOS Safari / companion app**: pin → screen off → audio continues while audible; after
  a long suspension the dock shows suspended on return; double-tap gives native video fullscreen.
- **Firefox**: stats overlay (`Shift+S`) shows non-zero `recv:` while streaming.
- **Kiosk / fullscreen dashboards**: cards attach on load (no black cards); dock still
  reachable (it is suppressed only while an element is actually fullscreen).

## Reporting

For any failure, capture: the debug overlay contents (it includes the version line),
the console, and `chrome://webrtc-internals` for the affected connection. The trace
prefix format is `<session id> | <call id> | <ms since call start>`.
