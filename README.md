# WebRTC Babycam

Webrtc babycam is a webrtc camera client implementation built with the intention of providing a unstoppable audio/video stream to be used as a baby monitor. 

With this goal in mind, standard video html element behaviors are overridden for continuous monitoring:
- Robust connection retry loops forever.
- 'Live' indicator provides positive confirmation that stream is playing.
- Fallback to image polling.
- Video stoppage / pause is reversed.
- Autoplay audio with reliable fallback to muted play. 
- Background audio mode allows client app to be sent to the background and continue streaming audio.

### Background

At the time of conception, other implementations lacked a robust connection retry loop. On failure, the camera would permanently stop streaming. Not appropriate for a babycam. This implementation will retry the webrtc server connection forever, as long as your client hasn't crashed. If your android client crashes, since autoplay unmuted audio is supported,  audio streaming restarts.

While establishing a webrtc connection or anytime an existing connection fails, the card falls back to image polling. The result is that there is an image available prior to the webrtc connection being established, and continuously on disconnect, even if webrtc connections are blocked.

HTML video elements were designed with playback in mind - in the browser, video streams are designed to be easily stopped. A baby monitor should not be accidentally stopped. A single click or tap  on video element will result in paused video that could go unnoticed. In this implementation, built-in audio/video controls are disable to prevent accidental pausing.  Stopped or paused video is automatically resumed.

Background audio features allow you to monitor your baby on your iphone, temporarily switch tabs or apps while continuously streaming audio.  
  

## Features

- Real-time two-way audio/video with near-zero latency. 
- Image snapshots when not streaming
- PTZ controls and service-based shortcuts
- Background streaming (keeps connection and audio alive while offscreen)
- Frame rate and bandwidth statistics 
- Stream only audio, only video, or both audio + video. 

- Debug (`Shift+D`) and stats (`Shift+S`) toggles

  
## Installation

1. Copy `webrtc-babycam.js` into your `www` folder.
2. Add it as a resource in your Lovelace dashboard:

```yaml
resources:
- url: /local/webrtc-babycam.js
  type: module

```
 

## Usage

Create a card in Lovelace:

```yaml
type: custom:webrtc-babycam
entity: camera.living_room
url: "http://your_webrtc_endpoint"
audio: true
video: true
unmuted: true
stats: false
debug: false
microphone: false
allow_background: true
```


## PTZ & Shortcuts (Optional)

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
 