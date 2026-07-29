# WebRTC Babycam

Webrtc babycam is a webrtc camera client implementation built to provide an unstoppable audio/video stream for use as a baby monitor. 

With this goal in mind, standard video html element behaviors are overridden for continuous monitoring:
- Robust connection retry loops forever.
- 'Live' indicator provides positive confirmation that stream is playing.
- Fallback to image polling.
- Video stoppage / pause is reversed.
- Autoplay audio with reliable fallback to muted play. 
- Background audio mode allows client app to be sent to the background and continue streaming audio.

### Background

When my daughter was born, I tried multiple options to stream a high quality video feed to be used as a baby monitor. Suprisingly, existing webrtc implementations lacked a  connection retry loop. Meaning, on failure, the video feed would permanently stop streaming - Not appropriate for a babycam. webrtc-babycam will retry the webrtc connection forever, for as long as the browser is running. 

Most other implementations do not support unmuted autoplay. After an application restart, audio is stopped until manually reenabled. webrtc-babycam streams audio unmuted on restart when allowed by your browser.

Most webrtc browser client implementations present a poster, or no image, when the webrtc connection is down. webrtc-babycam presents a camera snapshot while establishing a webrtc connection or anytime an existing connection fails. Webrtc-babycam is built to support fallback to image polling. This ensures that a recent camera image can always be shown, before the WebRTC connection is established and continuously during disconnects.

HTML video elements are designed with recorded video playback in mind - in the browser, video streams are designed to be conveniently stopped. A single click or tap on the video element pauses the stream, which is an undesirable feature for continuous monitoring - A baby monitor should never be accidentally stopped. In this implementation, built-in audio/video controls are disabled, and stopped or paused video is automatically resumed.

Additionally, background audio features allow you to monitor your baby on your iPhone and temporarily turn off the screen or switch apps while audio continues streaming.
  

## Features

- Real-time two-way audio/video with near-zero latency. 
- Image snapshots when not streaming
- PTZ controls and service-based shortcuts
- Background streaming (keeps connection and audio alive while offscreen)
- Frame rate and bandwidth statistics 
- Stream only audio, only video, or both audio and video. 

- Debug (`Shift+D`) and stats (`Shift+S`) toggles

  
## Installation

### HACS

1. In HACS, add `https://github.com/markfrancisonly/ha-babycam` as a custom
   **Integration** repository, then install **WebRTC Babycam**.
2. Restart Home Assistant.
3. Add **Babycam** under Settings → Devices & services → Add integration. Enter
   a go2rtc websocket base address reachable from Home Assistant, such as
   `ws://go2rtc-host:1984` (do not add
   `/api/ws`).

For a manual install, copy `custom_components/babycam` to
`config/custom_components/babycam`, restart Home Assistant, and complete step 3.

The integration bundles the card: it serves `webrtc-babycam.js` itself and
registers it as a dashboard resource automatically. The card is served with
`Cache-Control: no-cache` and validators, so a plain dashboard reload always
picks up an updated card (a cheap 304 when nothing changed) — no version
query, no Home Assistant restart, no `www` copy, and no manual resource
entry.

### Upgrading from the frontend-only card

Remove the old `/local/webrtc-babycam.js` dashboard resource after installing
the integration, and remove any separately copied `www/webrtc-babycam.js` file.
Keeping both resources can load two versions of the card. Existing card YAML
continues to work; when using the default `url_type: webrtc-babycam`, remove the
per-card `url` because the integration now owns the go2rtc server address.

If your dashboards are in **YAML mode**, resources are user-managed — add it
yourself (the integration logs the exact line at startup):

```yaml
resources:
  - url: /babycam/webrtc-babycam.js
    type: module
```

To confirm which version is actually running, check the browser console
banner, or enable the debug overlay (`Shift+D` or `?debug`) on any card: the
first log line shows the loaded version.
 
## Configuration

| **Name** | **Type** | **Default** | **Supported Options** | **Description** |
|----------|----------|-------------|----------------------|----------------|
| **entity** | `string` | **Required** | go2rtc stream name or camera entity ID | The stream passed to go2rtc. If it is also a Home Assistant entity, its `entity_picture` is used as the snapshot fallback. |
| **url** | `string` | (optional) | Any valid HTTP(s) or WebSocket URL | Not used by the default integration proxy. Required only for direct `go2rtc`, `webrtc-camera`, `whep`, or `rtsptoweb` transports. |
| **url_type** | `string` | `"webrtc-babycam"` | `"webrtc-babycam"`, `"hass"`, `"go2rtc"`, `"webrtc-camera"`, `"whep"`, `"rtsptoweb"` | Determines which signaling approach/class is used. |
| **video** | `boolean` | `true` | `true`, `false` | Enable (receive) video track. If `false`, video is disabled (audio-only or still images). |
| **audio** | `boolean` | `true` | `true`, `false` | Enable (receive) audio track. If `false`, audio is disabled entirely. |
| **start** | `string` | `live` | `live`, `image` | `image` opens the card in the snapshot loop (no WebRTC call) until a gesture goes live — tap then toggles image ↔ live and double-tap enters fullscreen. **Only `start: image` cards can be toggled back to a snapshot**: on live-first cards (the default) freezing video is unsupported — no gesture or action can stop a playing stream. Initial state only; not part of the session key. |
| **muted** | `boolean` | `true` | `true`, `false` | Mute the player element on load. If `false`, the player attempts to play with audio enabled, but browsers often require user interaction to unmute. |
| **microphone** | `boolean` | `false` | `true`, `false` | Enable *two-way audio* from the user’s microphone to the camera feed if the browser permits. |
| **background** | `boolean` | `false` | `true`, `false` | If `true`, enables "background mode," where the audio continues to play when off-screen. |
| **fullscreen** | `string` | (optional)  | `"video"`, `null` | `"video"` makes fullscreen always show live video: on a `video: false` card the fullscreen call is upgraded to video, and on a `start: image` card entering fullscreen goes live (the snapshot is restored on exit if fullscreen is what started the video). Omit it to let snapshot cards go fullscreen as a static image. |
| **debug** | `boolean` | `false` | `true`, `false` | Enables verbose logging. Shows a translucent debug panel capturing debug/tracing messages. |
| **stats** | `boolean` | `false` | `true`, `false` | Enables measurement and display of streaming stats (e.g., framerate, bandwidth). |
| **allow_background** | `boolean` | `false` | `true`, `false` | If `true`, allows toggling the “pin” icon to enable background mode. |
| **background_muted_grace** | `number` | `60000` | Milliseconds | How long a hidden background stream may stay autoplay-muted before it is parked (stopped, resumable from the dock). |
| **background_mute_policy** | `string` | `"park"` | `"park"`, `"keep"` | `"keep"` preserves the old behavior of streaming muted audio forever while hidden. |
| **background_video** | `string` | `"shed"` | `"shed"`, `"keep"` | `"shed"` renegotiates background calls audio-only while no card is visible (video restored on return); auto-falls back to `"keep"` if the source rejects audio-only offers. |
| **background_timeout** | `number` | `0` | Minutes (`0` = off) | Optional TTL: parks a background stream this long after the last user interaction (never silently — the dock shows it as paused and one tap resumes). |
| **dock** | `boolean` | `true` | `true`, `false` | `false` hides this camera from the minimized background dock (e.g. kiosk setups). |
| **allow_mute** | `boolean` | `true` | `true`, `false` | If `false`, prevents toggling the mute/unmute icon in the UI. |
| **allow_pause** | `boolean` | `false` | `true`, `false` | If `true`, allows pausing/resuming the stream with a pause icon. |
| **allow_microphone** | `boolean` | `false` | `true`, `false` | If `true`, the user can turn on/off the microphone during the session for two-way audio. |
| **fps** | `number` | (optional) | Any numeric FPS value | A numeric hint for frames per second (FPS) used to estimate "render quality" in stats. If `null`, auto-detects FPS. |
| **ice_servers** | `array` | (optional) | Array of `RTCIceServer` objects, or `[]` | Replaces the built-in Google STUN default. Use `[]` on LAN-only setups (host candidates suffice; nothing contacts Google), or supply your own STUN/TURN servers for remote access. |
| **image_url** | `string` | (optional)  | Any valid image URL | Custom URL for still snapshots when video is not playing. |
| **image_entity** | `string` | (optional)  | Any HA camera entity id | Fetch still snapshots from this entity's `entity_picture` when `entity` has no HA entity behind it (e.g. `entity` is a go2rtc stream name like `camera.doorbell_sub`). Poster priority: `entity` → `image_entity` → `image_url`. |
| **actions** | `object` | (optional) | Per-context gesture map | Configurable gestures: `actions.<context>.<gesture>` where context ∈ `image` \| `live` \| `fullscreen` and gesture ∈ `tap` \| `double_tap` \| `hold` (+ `swipe`, any direction, fullscreen only). Verbs: `fetch_image`, `go_live`, `go_image`, `toggle_live`, `fullscreen`, `toggle_fullscreen`, `fullscreen_live`, `close`, `toggle_mute`, `controls`, `more_info`, `none`, or a standard HA action object (`{action: perform-action \| navigate \| url \| more-info, ...}`). Defaults — image/paused: tap `fetch_image`, double_tap `fullscreen`, hold `fullscreen`; live: tap `toggle_live`, double_tap `fullscreen`, hold `toggle_mute`; fullscreen: tap/double_tap/swipe `close`. Taps pay a ~280 ms disambiguation delay only in contexts where a double_tap is configured. |
| **image_interval** | `number` | `3000` (default) | Any numeric value in milliseconds | Interval (in ms) for fetching a new still image when video is not playing. |
| **image_expiry** | `number` | `15000` (default) | Any numeric value in milliseconds | Time (in ms) before an image is considered expired or blurred. |
| **ptz** | `object` | (optional)  | PTZ service call object | Specifies *Pan/Tilt/Zoom* service calls. Example: `{ service: 'camera.ptz', data_up: {...} }`. |
| **style** | `string` | (optional)  | CSS string | Custom CSS block injected into the card’s Shadow DOM (e.g., for styling icons or layout). |
| **shortcuts** | `object` | (optional)  | Service shortcut object or array | Object/array of shortcut buttons that run HA services when clicked. Example: `{ services: [ { icon: 'mdi:lightbulb', service: 'light.turn_on' } ] }`. |


### Usage

Create a card in Lovelace:

```yaml
type: custom:webrtc-babycam
entity: camera.living_room
audio: true
video: true
muted: false
microphone: false
allow_background: true
```


### Gesture actions

Gestures are configurable per **context** — what the card is currently showing:

- `image` — natively snapshot mode (still connecting, or video/audio disabled)
- `live` — WebRTC streaming
- `paused` — viewer tapped a live card into image mode (`toggle_live`/`go_image`)
- `fullscreen` — native element fullscreen **or** the remote overlay

Gestures: `tap`, `double_tap`, `hold` everywhere, plus `swipe` (any direction)
in fullscreen only (embedded swipes would fight dashboard scrolling).

Verbs: `fetch_image`, `go_live`, `go_image`, `toggle_live`, `fullscreen`,
`toggle_fullscreen`, `fullscreen_live`, `close`, `toggle_mute`, `controls`,
`more_info`, `none`, or a standard HA action object
(`{action: perform-action | navigate | url | more-info, ...}`).

`fullscreen` opens fullscreen in the card's *current* mode (a parked snapshot
card fullscreens the refreshing still). `fullscreen_live` always shows live
video in fullscreen — the per-gesture counterpart to `fullscreen: "video"` —
and closing fullscreen reverses the go-live if this gesture is what started it.

Defaults:

```yaml
actions:
  image:      { tap: fetch_image, double_tap: fullscreen, hold: fullscreen }
  live:       { tap: toggle_live, double_tap: fullscreen, hold: toggle_mute }
  paused:     { tap: fetch_image, double_tap: fullscreen, hold: fullscreen }
  fullscreen: { tap: close, double_tap: close, hold: none, swipe: close }
```

In words: on a snapshot (image-first parked, or natively snapshot mode) tap
refreshes the still and double-tap fullscreens in current mode; on live video
tap stops it **only on `start: image` cards** (live-first cards never stop)
and double-tap fullscreens; inside fullscreen any tap or swipe closes. Starting
video is always an explicit config choice (`toggle_live`, `go_live`,
`fullscreen_live`), never a default single tap.

Notes: taps pay a ~280 ms disambiguation delay only in contexts where a
`double_tap` is configured; single-tap and hold verbs therefore dispatch from a
timer, outside the browser's user-activation window — if the engine refuses
`requestFullscreen()` there (WebKit does), the card falls back to its own
full-viewport overlay; gestures stand down while native video controls
are visible; `toggle_live` is session-scoped (cards sharing a stream pause and
resume together) and keeps the snapshot loop polling while paused.

### Babycam custom integration (fullscreen overlay + go2rtc proxy)

The repo ships `custom_components/babycam` (successor to the local AlexxIT
`webrtc` fork; domain `babycam`, API paths `/api/babycam/*` so it coexists
with that integration and HA's built-in go2rtc):

- **Signaling proxy** — the card's default `url_type: webrtc-babycam` signs
  and connects through `/api/babycam/ws`, which proxies to the go2rtc server
  configured in the integration's config entry (a `ws(s)://` URL).
- **`babycam.open` / `babycam.close` services** — open/close a **fullscreen
  overlay on every connected browser** (true 100% viewport, above all app
  chrome). All service fields are forwarded verbatim as the card config —
  `entity` (stream), `image_entity`, `actions`, etc. Non-admin browsers receive
  events via the integration's
  `babycam/subscribe` websocket command (arbitrary bus-event subscriptions
  are admin-only in HA).

```yaml
# e.g. a doorbell automation
- action: babycam.open
  data:
    entity: camera.doorbell_sub
    image_entity: camera.doorbell     # instant poster
- delay: 15
- action: babycam.close
```

### Local fullscreen from any dashboard card

To open the overlay **on this browser only** (unlike the broadcast service),
use `fire-dom-event` from any card — no browser_mod required:

```yaml
type: picture-entity
entity: camera.front_yard
tap_action:
  action: fire-dom-event
  babycam:
    entity: camera.front_yard
```

`babycam: close` (or `babycam: {action: close}`) closes it. Inside the
overlay, the card's `fullscreen` gesture context applies — tap or swipe
closes by default.

### PTZ & Shortcuts (Optional)

```yaml
ptz:
  service: rest_command.move_camera
  data_right: {cmd: "right"}
  data_left: {cmd: "left"}

shortcuts:
  - name: Turn on light
    icon: mdi:lightbulb
    service: light.turn_on
    service_data:
      entity_id: light.nursery
```

## Background mode & the dock

Pinning a card (the pin step in the volume-icon cycle) keeps its audio streaming when the
card leaves the screen. While a background stream is active and its card is not visible, a
small **dock** pill appears bottom-center on the dashboard. Tapping it lists each background
camera with its live state and two actions: **return** (navigate back to the camera's view)
and **close** (stop the background stream, with a 5-second UNDO). If background audio was
blocked by the browser's autoplay policy, the row says so — tapping it is the unmute gesture.
After a reload, pinned cameras show as *suspended* chips; one tap reopens them.

Background sessions are coordinated across tabs (only one tab streams a hidden camera),
survive page lifecycle events (bfcache, tab freeze), shed video while nothing renders it,
and park themselves — visibly, never silently — when audio cannot be heard. See
[docs/background-mode.md](docs/background-mode.md) for the full design.

## Keyboard Shortcuts

-  **Shift+T**: Toggle global mute
-  **Shift+D**: Toggle debug output
-  **Shift+S**: Toggle stats panel 

Shortcuts are ignored while typing in input fields.
 
