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

1. Copy `webrtc-babycam.js` into your `www` folder.
2. Add it as a resource in your Lovelace dashboard:

```yaml
resources:
- url: /local/webrtc-babycam.js
  type: module

```
 
## Configuration

| **Name** | **Type** | **Default** | **Supported Options** | **Description** |
|----------|----------|-------------|----------------------|----------------|
| **entity** | `string` | **Required** | Camera entity ID, e.g. `camera.front_door` | The Home Assistant camera entity to use. Used for `entity_picture` (fallback) or passing along an identifier to the signaling server. |
| **url** | `string` | **Required** | Any valid HTTP(s) or WebSocket URL | Base or direct URL for the WebRTC signaling or camera feed, e.g., `go2rtc` or `RTSPtoWeb` server URL. |
| **url_type** | `string` | `"webrtc-babycam"` | `"webrtc-babycam"`, `"go2rtc"`, `"webrtc-camera"`, `"whep"`, `"rtsptoweb"` | Determines which signaling approach/class is used. |
| **video** | `boolean` | `true` | `true`, `false` | Enable (receive) video track. If `false`, video is disabled (audio-only or still images). |
| **audio** | `boolean` | `true` | `true`, `false` | Enable (receive) audio track. If `false`, audio is disabled entirely. |
| **muted** | `boolean` | `true` | `true`, `false` | Mute the player element on load. If `false`, the player attempts to play with audio enabled, but browsers often require user interaction to unmute. |
| **microphone** | `boolean` | `false` | `true`, `false` | Enable *two-way audio* from the user’s microphone to the camera feed if the browser permits. |
| **background** | `boolean` | `false` | `true`, `false` | If `true`, enables "background mode," where the audio continues to play when off-screen. |
| **fullscreen** | `string` | (optional)  | `"video"`, `null` | Controls whether entering fullscreen enables video. `"video"` automatically enables video when fullscreen. |
| **debug** | `boolean` | `false` | `true`, `false` | Enables verbose logging. Shows a translucent debug panel capturing debug/tracing messages. |
| **stats** | `boolean` | `false` | `true`, `false` | Enables measurement and display of streaming stats (e.g., framerate, bandwidth). |
| **allow_background** | `boolean` | `false` | `true`, `false` | If `true`, allows toggling the “pin” icon to enable background mode. |
| **allow_mute** | `boolean` | `true` | `true`, `false` | If `false`, prevents toggling the mute/unmute icon in the UI. |
| **allow_pause** | `boolean` | `false` | `true`, `false` | If `true`, allows pausing/resuming the stream with a pause icon. |
| **allow_microphone** | `boolean` | `false` | `true`, `false` | If `true`, the user can turn on/off the microphone during the session for two-way audio. |
| **fps** | `number` | (optional) | Any numeric FPS value | A numeric hint for frames per second (FPS) used to estimate "render quality" in stats. If `null`, auto-detects FPS. |
| **image_url** | `string` | (optional)  | Any valid image URL | Custom URL for still snapshots when video is not playing. |
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
url: "http://your_webrtc_endpoint"
audio: true
video: true
unmuted: true
microphone: false
allow_background: true
```


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

## Keyboard Shortcuts

-  **Shift+T**: Toggle global mute
-  **Shift+D**: Toggle debug output
-  **Shift+S**: Toggle stats panel 
 
