console.info(
    `%c  WebRTC Babycam \n%c`,
    'color: orange; font-weight: bold; background: black',
    'color: white; font-weight: bold; background: dimgray',
);

/**
 * WebRTC Babycam Custom Element
 * Provides a lag-free 2-way audio, video, and image camera card to monitor your favorite infant, nanny, or pet.
 */
class WebRTCsession {
    static sessions = new Map();
    static unmuteEnabled = false;

    // Timeout configurations in milliseconds
    static TIMEOUT_SIGNALING = 10000;
    static TIMEOUT_ICE = 10000;
    static TIMEOUT_RENDERING = 10000;
    static TIMEOUT_ERROR = 30000;
    static TIMEOUT_IMAGE = 10000;
    static IMAGE_INTERVAL = 3000;

    constructor(key, hass, config) {
        if (!config || !config.entity) {
            throw new Error("Entity configuration is required but entity needn't exist");
        }

        this.key = key;
        this.hass = hass;
        this.config = config;

        this.state = {
            cards: new Set(),
            lastCard: null,
            card: null,
            call: null,
            media: null,
            image: null,
            reconnectDate: 0,
            status: 'uninitialized'
        };

        this.lastError = null;
        this.eventTarget = new EventTarget();
        this.fetchImageTimeoutId = undefined;
        this.imageLoopTimeoutId = undefined;
        this.watchdogTimeoutId = undefined;

        this.trace = () => { };
        this.resetStats();

        if (this.config.background === true && this.background === false)
            this.background = true;

        if (this.config.microphone === true && this.microphone === false)
            this.microphone = true;
        
        this.mediaEventHandlers = {};  
    }

    static key(config) {
        let key = config.entity.replace(/[^a-z0-9A-Z_-]/g, '-'); // Added 'g' flag to replace all occurrences

        // default true
        if (config.audio === false) key += '-a';
        if (config.video === false) key += '-v';

        // default false
        if (config.microphone !== true) key += '-m';
        return key;
    }

    static create(config) {
        let hass = document.body.querySelector("home-assistant")?.hass;
        let key = WebRTCsession.key(config);
        let session = WebRTCsession.sessions.get(key);
        if (!session) {
            session = new WebRTCsession(key, hass, config);
            WebRTCsession.sessions.set(key, session);
        }
        console.debug(`****** created session ${key} #${WebRTCsession.sessions.size}`);
        return session;
    }

    formatBytes(a, b = 2) { 
        if (!+a) return "0 Bytes"; 
        const c = 0 > b ? 0 : b, 
              d = Math.floor(Math.log(a) / Math.log(1024)); 
        return `${parseFloat((a / Math.pow(1024, d)).toFixed(c))} ${["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"][d]}` 
    }

    resetStats() {
        this.stats = {
            imageBytesReceived: 0,
            peerBytesReceived: 0,
            frameWidth: 0,
            frameHeight: 0,
            framesDecoded: 0,
            framesDropped: 0,
            totalFreezesDuration: 0,
            tlsVersion: "",
            dtlsCipher: "",
            srtpCipher: ""
        };
        this.statsHistory = [];
    }

    calculateMode(a) {
        const mode = {};
        let max = 0, count = 0;
        for (let i = 0; i < a.length; i++) {
            const item = a[i];
            if (mode[item]) {
                mode[item]++;
            } else {
                mode[item] = 1;
            }
            if (count < mode[item]) {
                max = item;
                count = mode[item];
            }
        }
        return max;
    }

    async getStats(call) {
        if (!call?.peerConnection) return;

        try {
            const result = await call.peerConnection.getStats(null);
            result.forEach(report => {
                if (report.type === "transport") {
                    // RTCTransportStats
                    this.stats.peerBytesReceived = report["bytesReceived"] || 0;
                    this.stats.tlsVersion = report["tlsVersion"] || "";
                    this.stats.dtlsCipher = report["dtlsCipher"] || "";
                    this.stats.srtpCipher = report["srtpCipher"] || "";
                }
                else if (report.type === "inbound-rtp") {
                    // RTCInboundRtpStreamStats
                    this.stats.frameWidth = report["frameWidth"] || 0;
                    this.stats.frameHeight = report["frameHeight"] || 0;
                    this.stats.framesDecoded = report["framesDecoded"] || 0;
                    this.stats.framesDropped = report["framesDropped"] || 0;
                    this.stats.totalFreezesDuration = report["totalFreezesDuration"] || 0;
                }
            });
        } catch (err) {
            this.trace(`Error fetching stats: ${err.message}`);
        }
    }

    async displayStats() {
        let prev = null;
        if (this.statsHistory.length > 0) {
            prev = this.statsHistory[this.statsHistory.length - 1];
        }

        const current = { ...this.stats };
        current.timestamp = Date.now();

        if (prev && current.timestamp - prev.timestamp < 500) {
            return;
        }

        // Keep history of the past few seconds 
        this.statsHistory.push(current);
        if (this.statsHistory.length > 10) {
            this.statsHistory.shift();
        }

        if (prev == null) return;

        const deltaBytes = (current.imageBytesReceived + current.peerBytesReceived) - (prev.imageBytesReceived + prev.peerBytesReceived);
        const deltaFrames = (current.framesDecoded) - (prev.framesDecoded);
        const deltaTime = (current.timestamp) - (prev.timestamp);

        if (deltaFrames < 0 || deltaTime <= 0) {
            // framesDecoded has *decreased*, we've likely had a reset
            this.statsHistory = [current];
            return;
        }

        const card = this.state.activeCard;
        if (!card) return;

        let header = "";
        current.bps = (deltaBytes / (deltaTime / 1000));
        header += `recv: ${this.formatBytes(current.bps)}/s `;

        if (this.config.video !== false) {
            current.fps = Math.round((deltaFrames / (deltaTime / 1000)));
            header += `<br>fps: ${current.fps}`;

            let guessedFps;
            if (this.statsHistory.length >= 10) {
                guessedFps = this.config.fps;
                if (!guessedFps) {
                    const fpsHistory = this.statsHistory.map(a => a.fps);
                    current.fpsMode = this.calculateMode(fpsHistory);
                    const fpsModeHistory = this.statsHistory.map(a => a.fpsMode);
                    guessedFps = this.config.fps ?? this.calculateMode(fpsModeHistory);
                    if (!guessedFps || guessedFps < 1) guessedFps = 1;
                }
            }

            if (guessedFps) {
                const reference = this.statsHistory[0];
                const playTime = (current.timestamp) - (reference.timestamp);
                const framesDecoded = current.framesDecoded - reference.framesDecoded;
                const frameExpected = (playTime / 1000) * guessedFps;
                let frameDecodeRate = framesDecoded / frameExpected;

                if (framesDecoded < 0 || frameExpected <= 0) {
                    // ounters have reset in the middle, or time is invalid
                    this.statsHistory = [current];
                    return;
                }

                if (frameDecodeRate >= 0.995) frameDecodeRate = 1;

                header += `<br>render quality: ${(frameDecodeRate * 100).toFixed(1)}%`;
            }
        }
        this.state.activeCard.header = header;
    }

    imageLoop() {
        if (this.imageLoopTimeoutId) {
            return;
        }
        else if (this.isTerminated) {
            this.imageLoopTimeoutId = undefined;
            return;
        }

        let interval;
        if (this.config.video === false)
            interval = this.state.activeCard?.config?.interval ?? this.config.interval ?? WebRTCsession.IMAGE_INTERVAL;
        else
            interval = WebRTCsession.IMAGE_INTERVAL;

        if (interval == 0) return;

        this.imageLoopTimeoutId = setTimeout(() => {
            this.imageLoopTimeoutId = undefined;
            this.imageLoop();
        }, interval);

        const media = this.media;
        if (media
            && (media.getAttribute('playing') === 'audiovideo'
                || media.getAttribute('playing') === 'video')) {
            return;
        }
        this.fetchImage();
    }

    play(id = undefined) {
        if (id != this.watchdogTimeoutId) {
            return;
        }

        let playing = false;

        try {
            if (!id) {
                this.imageLoopTimeoutId = undefined;
                this.setStatus('reset');
                this.resetStats();
            }

            this.imageLoop();
            const now = Date.now();

            if (this.config.video === false && this.config.audio === false) {
                // WebRTC disabled 
                this.extendConnectionTimeout(1000);
            }
            else if (now < this.state.reconnectDate) {
                // Connecting or previously connected, extend reconnection timeout if media is playing normally

                if (this.isStreaming) {
                    // WebRTC peer connected

                    const media = this.media;
                    const state = media ? media.getAttribute('playing') : null;

                    switch (state) {
                        case "audio":
                        case "video":
                        case "audiovideo":
                            // Loaded media is playing normally

                            playing = true;
                            this.extendConnectionTimeout(WebRTCsession.TIMEOUT_RENDERING);
                            break;

                        case "paused":
                            // Loaded media is paused

                            if (this.config.pause || media.tagName == 'AUDIO') {

                                // Paused media allowed
                                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_RENDERING);
                            }
                            else {

                                // Unpause video as default behavior
                                this.playMedia();
                            }
                            break;

                        default:
                            // Media hasn't loaded 

                            if (media && media.tagName == 'AUDIO' && media.muted) {

                                // Muted audio-only media is acceptable 
                                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_RENDERING);
                            }
                    }

                    if (this.state.activeCard?.config.stats)
                        this.getStats(this.state.call);

                }
                else {
                    // Waiting for connection 
                }
            }
            else {
                if (this.state.call)
                    this.trace(`Play watchdog timeout`);

                this.endCall(this.state.call);
                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);
                this.startCall();
            }

            if (this.state.activeCard?.config.stats)
                this.displayStats();
        }
        catch (err) {
            this.lastError = err.message;
            this.trace(`Play ${err.name}: ${err.message}`);
        }
        finally {
            const now = Date.now();
            const sync = 1000 - now % 1000;
            const delay = Math.max(0, Math.min(this.state.reconnectDate - Date.now(), sync));

            this.alive(playing);

            const loop = setTimeout(() => this.play(loop), delay);
            this.watchdogTimeoutId = loop;
        }
    }

    alive(on) {
        const container = this.state.activeCard?.shadowRoot?.querySelector(".media-container");
        if (!container) return;

        let live = container.querySelector(`.live`);
        if (!live) {
            const style = `
            <style>
                @keyframes disappear {
                    from { visibility: visible; }
                    to { visibility: hidden; } 
                } 
                .live {
                    position: absolute; 
                    left: 20px;
                    top: 20px;
                    width: 10px; 
                    min-width: 0.5vmax;
                    visibility: hidden;
                    pointer-events: none;
                    z-index: 7;
                }
                .media[playing="video"] ~ .live[on], .media[playing="audiovideo"] ~ .live[on] {
                    animation: disappear 4000ms steps(2, jump-none) 1;
                    color: red;
                } 
                .media[playing="audio"] ~ .live[on] {
                    animation: disappear 4000ms steps(2, jump-none) 1;
                    color: white;
                } 
            </style>
            `;
            this.state.activeCard.shadowRoot.querySelector('.card').insertAdjacentHTML('beforebegin', style);

            const svg = `<svg class="live" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="50%" cy="50%" r="4" fill="currentColor" />
                        </svg>`;

            container.insertAdjacentHTML('beforeend', svg);
            live = container.querySelector(`.live`);
        }

        if (on) {
            if (live.hasAttribute("on")) {
                const animation = live.getAnimations()[0];
                animation?.cancel();
                animation?.play();
            }
            else {
                live.setAttribute("on", "");
            }
        }
        else {
            live?.removeAttribute("on");
        }
    }

    set tracing(enabled) {
        if (enabled)
            this.trace = this._trace.bind(this); // Bind the trace method to maintain context
        else
            this.trace = () => { };
    }

    _trace(message, o) {
        const text = `${this.key}:${(new Date().getTime())}: ${message}`;
        if (o)
            console.debug(text, o);
        else
            console.debug(text);

        this.eventTarget.dispatchEvent(new CustomEvent('trace', { detail: { message: text } }));
    }

    /**
     * @param {Number} ms milliseconds from now before automatic restart
     */
    extendConnectionTimeout(ms = 0) {
        this.state.reconnectDate = Math.max(Date.now() + ms, this.state.reconnectDate);
    }

    restart(call) {
        this.traceCall(call, 'Restarting call.');
        this.endCall(call);

        clearTimeout(this.watchdogTimeoutId);
        this.watchdogTimeoutId = undefined;
        this.state.reconnectDate = 0;
        this.play();
    }

    attachCard(card) {
        /*  
            Instead of creating a new media element for each card, 
            a media element singleton is attached or detached from the active card
            to support background streaming 
        */
        
        this.trace('Attaching new card to session');
        const activeCard = this.state.activeCard;

        if (this.terminationTimeoutId) {
            clearTimeout(this.terminationTimeoutId);
            this.terminationTimeoutId = null;
            this.trace("Pending termination aborted due to reattachment");
        }

        this.state.cards.add(card);
        this.state.activeCard = card;

        if (this.config.audio === false && this.config.video === false) {
            setTimeout(() => this.play(), 0);
            return;
        }

        if (!this.state.media)
            this.state.media = this.createMedia();
                
        const media = this.state.media;
        const parent = card.shadowRoot;
        if (parent) {
            const container = parent.querySelector('.media-container');

            if (!container) {
                // Container not yet in the DOM => schedule a re-try
                this.trace("media-container not found, deferring attachCard");
                requestAnimationFrame(() => this.attachCard(card));
                return;
            }

            if (!container.contains(media)) {
                if (media.parentNode) {
                    //media.remove();
                    this.trace('Media element container changed');
                }
                container.insertBefore(media, container.querySelector('.state'));
            }
        }

        // Inject card configuration
        this.config.muted = card.cardConfig.muted;
        this.config.allow_background = card.cardConfig.allow_background;
        this.config.allow_mute = card.cardConfig.allow_mute;
        this.config.stats = card.cardConfig.stats;

        const searchParams = new URLSearchParams(window.location.search);
        if (searchParams.has('debug'))
            this.config.debug = (searchParams.get('debug') !== 'false');

        if (searchParams.has('stats'))
            this.config.stats = (searchParams.get('stats') !== 'false');

        if (!this.background) {
            if (this.config.muted !== false)
                this.muteMedia();
            else
                this.unmuteMedia();
        }

        WebRTCsession.enablePinchZoom();

        // Start streaming only if the card is actually visible or we're allowed in background
        if (card.isVisibleInViewport || this.background) {
            setTimeout(() => this.play(), 0);
        } else {
            this.trace("attachCard: card is not visible & background is false => not playing");
        }

    }

    detachCard(card) {
    
        if (!this.state.cards.has(card)) {
            this.trace("detachCard: Card mismatch or already detached; skipping");
            return;
        }

        this.state.cards.delete(card);
        if (this.state.activeCard === card) {
            this.state.activeCard = null;
        }

        if (this.background) {
            this.trace("Sent to background — keeping session alive with 0 visible cards");
            return;
        }                

            // If we still have at least one other card attached, do nothing. 
        if (this.state.cards.size > 0) {
            this.trace("Another attached card is still using this session; not terminating.");
            return;
        }
                
        // No cards left, no background => schedule a delayed termination
        this.trace("Termination pending (no cards remain)");
        const delayBeforeTermination = 2000; // e.g., 2 seconds
        this.terminationTimeoutId = setTimeout(() => {
            // If some new card attached while we were waiting, skip termination
            if (this.state.cards.size > 0) {
                this.trace("Reattachment detected; aborting termination");
                this.terminationTimeoutId = null;
            } else {
                this.trace("No reattachment detected; terminating session");
                this.terminate();
            }
        }, delayBeforeTermination);
                

        // let activeCardCount = 0;
        // const iterator = WebRTCsession.sessions.values();
        // for (const session of iterator) {
        //     if (session.state.activeCard) {
        //         activeCardCount++;
        //     }
        // }
        // if (activeCardCount === 0)
        //     WebRTCsession.restorePinchZoomDefaults();
    }

    static enablePinchZoom() {
        let viewport = document.querySelector("meta[name=viewport]");
        if (!viewport) {
            viewport = document.createElement("meta");
            viewport.setAttribute("name", "viewport");
            viewport.setAttribute("content", "width=device-width, viewport-fit=cover");
            document.head.appendChild(viewport);
        }

        if (!WebRTCsession.defaultViewportContent) {
            const mediaQueryList = window.matchMedia("(orientation: portrait)");
            mediaQueryList.addEventListener('change', () => WebRTCsession.resetPinchZoomScale());
            WebRTCsession.defaultViewportContent = viewport.getAttribute('content');
        }

        WebRTCsession.resetPinchZoomScale();
        viewport.setAttribute('content', "initial-scale=1.0, minimum-scale=1.0, maximum-scale=5.0");
    }

    static resetPinchZoomScale() {
        const initialScale = window.visualViewport?.scale;
        const viewport = document.querySelector("meta[name=viewport]");
        const content = viewport.getAttribute('content');
        viewport.setAttribute('content', "initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0");
        viewport.setAttribute('content', content);
        const resetScale = window.visualViewport?.scale;
    }

    static restorePinchZoomDefaults() {
        WebRTCsession.resetPinchZoomScale();
        const viewport = document.querySelector("meta[name=viewport]");
        viewport.setAttribute("content", WebRTCsession.defaultViewportContent);
    }

    /**
     * Current status: 'started', 'terminated', 'error', 'loading', 'disconnected', 'paused', or 'playing'
     */
    get status() {
        return this.state.status;
    }

    setStatus(value) {
        if (this.state.status === value) return;

        this.state.status = value;
        this.trace(`${value}`);
        this.eventTarget.dispatchEvent(new CustomEvent('statuschange', { detail: { status: value } }));
    }

    terminate() {
        this.setStatus('terminated');
        this.state.reconnectDate = 0;
        this.state.activeCard = null;
        WebRTCsession.sessions.delete(this.key);

        clearTimeout(this.watchdogTimeoutId);
        clearTimeout(this.imageLoopTimeoutId);
        clearTimeout(this.fetchImageTimeoutId);
        this.watchdogTimeoutId = undefined;
        this.imageLoopTimeoutId = undefined;
        this.fetchImageTimeoutId = undefined;

        this.endCall(this.state.call);
    }

    get background() {
        return localStorage.getItem(`webrtc.${this.key}.background`)?.toLowerCase() === 'true';
    }

    set background(value) {
        localStorage.setItem(`webrtc.${this.key}.background`, value);
        this.eventTarget.dispatchEvent(new CustomEvent('backgroundchange', { detail: { background: value } }));
    }

    get microphone() {
        return localStorage.getItem(`webrtc.${this.key}.microphone`)?.toLowerCase() === 'true';
    }

    set microphone(value) {
        localStorage.setItem(`webrtc.${this.key}.microphone`, value);
        if (this.isStreaming)
            this.restart(this.state.call);
        this.eventTarget.dispatchEvent(new CustomEvent('microphonechange', { detail: { microphone: value } }));
    }

    get isTerminated() {
        return this.state.status == 'terminated';
    }

    get isStreaming() {
        const s = this.state.call?.peerConnection?.iceConnectionState;
        return s === "connected" || s === "completed";
    }

    get isStreamingAudio() {
        return this.state.call?.remoteStream?.getAudioTracks()?.length > 0;
    }

    get media() {
        return this.state.media;
    }

    /**
     * Invoked whenever the browser is expected to allow unmuted audio play 
     */
    static enableUnmute() {
        if (WebRTCsession.unmuteEnabled)
            return;
        else
            WebRTCsession.unmuteEnabled = true;

        const iterator = WebRTCsession.sessions.values();
        for (const session of iterator) {
            const media = session.media;
            if (media) {
                if (media.classList.contains('unmute-pending')) {
                    media.classList.remove('unmute-pending');
                    if (!session.isTerminated)
                        media.muted = false;
                }
            }
        }
    }

    unmuteMedia() {
        const media = this.media;
        if (media?.muted) {
            if (WebRTCsession.unmuteEnabled) {
                media.classList.remove('unmute-pending');
                media.muted = false;
            }
            else {
                // Browser won't play unmuted audio, save intention and unmute when enabled
                media.classList.add('unmute-pending');
            }
        }
    }

    muteMedia() {
        const media = this.media;
        if (media) {
            media.classList.remove('unmute-pending');
            media.muted = true;
        }
    }

    toggleVolume() {
        const media = this.media;
        if (!media) return;
    
        const allowBackground = this.config.allow_background ?? this.config.background ?? false;
        const allowMute = this.config.allow_mute ?? true;

        if (this.background) {
            this.trace("Exiting background mode");
            this.background = false;

            if (allowMute) {
                this.trace("Muting media");
                this.muteMedia();
            }
            return;
        }
    
        // not in background
        if (media.muted) {
            this.trace("Unmuting media");
            this.unmuteMedia();
            return;
        }
    
        // no audio or unmuted
        if (allowBackground) {
            this.trace("Enabling background mode");
            this.background = true;
            return;
        }

        if (allowMute) {
            this.trace("Muting media");
            this.muteMedia();
        }
    }
    

    pauseMedia() {
        const media = this.media;
        if (!media) return;
        media.classList.add('pause-pending');
        media.pause();
    }

    playMedia(muted) {
        if (this.isTerminated) return;

        const media = this.media;
        if (!media) return;

        if (media.srcObject == null) {
            this.trace('Cannot play media without source stream');
            return;
        }

        if (muted === true) {
            media.muted = true;
        }
        else if (muted === false) {
            if (media.muted) {
                media.muted = false;
                media.classList.add('unmute-pending');
            }
        }
        else if (media.tagName == 'AUDIO' && media.muted) {
            // Do not attempt to play muted audio 
            return;
        }

        media.play()
            .then(() => {
                if (!media.muted) {
                    media.classList.remove('unmute-pending');
                    WebRTCsession.enableUnmute();
                }
                media.classList.remove('pause-pending');
            })
            .catch(err => {
                if (err.name == "NotAllowedError" && !media.muted && muted != true) {
                    WebRTCsession.unmuteEnabled = false;

                    media.classList.add('unmute-pending');
                    this.trace('Unmuted play failed, reloading media muted');

                    media.muted = true;
                    media.load();
                    this.playMedia(true);
                }
                else if (err.name === "AbortError") {
                    this.trace(`Media play aborted: ${err.message}`);
                }
                else {
                    this.trace(`Media play failed: ${err.message}`);
                }
            });
    }

    unloadRemoteMedia(call) {

        const media = this.state.media;
        if (media) {
            media.removeAttribute('playing');
            media.removeAttribute('loaded');
            media.srcObject = null;
            this.traceCall(call, "Unloaded remote media");
            
            this.removeMediaListeners(media)    
            if (media.parentNode) {
                media.remove();
            }
            this.state.media = null;
        }

        if (this.status !== "error")
            this.setStatus('disconnected');
    }

    loadRemoteMedia(call) {

        if (!this.state.media)
            this.state.media = this.createMedia();

        const media = this.state.media;
        const remoteStream = call.remoteStream;
        
        if (!media || !remoteStream || media.srcObject === remoteStream)
            return;

        this.traceCall(call, `Call connection took ${Date.now() - call.startDate}ms`);

        media.setAttribute('loaded', Date.now());
        media.srcObject = remoteStream;
        this.traceCall(call, "Loading media");

        this.playMedia();
    }

    createMedia() {
        let media;

        if (this.config.video === false) {
            media = document.createElement('audio');
        }
        else {
            media = document.createElement('video');
        }

        media.className = 'media';
        media.setAttribute('playsinline', '');
        media.playsinline = true;

        media.setAttribute('muted', '');

        if (this.config.muted === false || this.background) {
            media.muted = false;
            media.classList.add('unmute-pending');
        }
        else {
            media.muted = true;
        }

        media.controls = false;
        media.autoplay = false;

        // Initialize media event handlers storage if not already
        if (!this.mediaEventHandlers) {
            this.mediaEventHandlers = {};
        }

        // Bind and store named handlers
        this.mediaEventHandlers.onEmptied = this.handleMediaEmptied.bind(this);
        this.mediaEventHandlers.onPause = this.handleMediaPause.bind(this);
        this.mediaEventHandlers.onCanPlay = this.handleMediaCanPlay.bind(this);
        this.mediaEventHandlers.onPlay = this.handleMediaPlay.bind(this);
        this.mediaEventHandlers.onPlaying = this.handleMediaPlaying.bind(this);
        this.mediaEventHandlers.onVolumeChange = this.handleMediaVolumeChange.bind(this);
        this.mediaEventHandlers.onDblClick = this.handleMediaDblClick.bind(this);
        this.mediaEventHandlers.onClick = this.handleMediaClick.bind(this);
        this.mediaEventHandlers.onError = this.handleMediaError.bind(this);

        // Attach event listeners using addEventListener
        media.addEventListener('emptied', this.mediaEventHandlers.onEmptied);
        media.addEventListener('pause', this.mediaEventHandlers.onPause);
        media.addEventListener('canplay', this.mediaEventHandlers.onCanPlay);
        media.addEventListener('play', this.mediaEventHandlers.onPlay);
        media.addEventListener('playing', this.mediaEventHandlers.onPlaying);
        media.addEventListener('volumechange', this.mediaEventHandlers.onVolumeChange);
        media.addEventListener('dblclick', this.mediaEventHandlers.onDblClick);
        media.addEventListener('click', this.mediaEventHandlers.onClick);
        media.addEventListener('error', this.mediaEventHandlers.onError);

        this.trace(`Created ${media.tagName.toLowerCase()} element`);

        return media;
    }

    removeMediaListeners(media) {
        if (!this.mediaEventHandlers) return;
    
        media.removeEventListener('emptied', this.mediaEventHandlers.onEmptied);
        media.removeEventListener('pause', this.mediaEventHandlers.onPause);
        media.removeEventListener('canplay', this.mediaEventHandlers.onCanPlay);
        media.removeEventListener('play', this.mediaEventHandlers.onPlay);
        media.removeEventListener('playing', this.mediaEventHandlers.onPlaying);
        media.removeEventListener('volumechange', this.mediaEventHandlers.onVolumeChange);
        media.removeEventListener('dblclick', this.mediaEventHandlers.onDblClick);
        media.removeEventListener('click', this.mediaEventHandlers.onClick);
        media.removeEventListener('error', this.mediaEventHandlers.onError);
    
        this.mediaEventHandlers = {};
    }

    // Media Event Handlers

    handleMediaEmptied() {
        this.trace('Media emptied');
        this.media.removeAttribute('playing');
    }

    handleMediaPause() {
        if (this.isTerminated) return;

        this.media.setAttribute('playing', 'paused');
        this.setStatus('paused');

        if (this.media.classList.contains('pause-pending')) {
            this.media.classList.remove('pause-pending');
            return;
        }

        // Override default media element behavior: disable pause for live streams 
        const shouldAllowPause = (this.media.controls && this.config.pause);

        if (this.media.tagName === 'AUDIO') {
            if (shouldAllowPause) {
                // Override default audio element behavior: mute on pause
                this.media.muted = true;
            }
            else if (this.media.muted === false) {
                this.trace('Unpausing audio');
                this.playMedia();
            }
            return;
        }

        if (!shouldAllowPause) {
            this.trace('Unpausing video');
            this.playMedia();
        }
    }

    handleMediaCanPlay() {
        // Autoplay implementation
        this.playMedia();
    }

    handleMediaPlay() {
        if (this.config.muted === false && this.media.tagName === 'AUDIO') {
            // Override default audio element behavior: unmute on play
            this.unmuteMedia();
        }
    }

    handleMediaPlaying() {
        if (this.media.tagName === 'AUDIO')
            this.media.setAttribute('playing', 'audio');
        else if (this.isStreamingAudio)
            this.media.setAttribute('playing', 'audiovideo');
        else
            this.media.setAttribute('playing', 'video');

        const loadTime = Date.now() - Number(this.media.getAttribute('loaded'));
        this.trace(`Media load took ${loadTime}ms`);

        const w = this.media.videoWidth || 0;
        const h = this.media.videoHeight || 0;
        let aspectRatio = 0;
        if (h > 0) {
            aspectRatio = (w / h).toFixed(4);
        }
        this.media.setAttribute("aspect-ratio", aspectRatio);
        this.media.style.setProperty(`--video-aspect-ratio`, `${aspectRatio}`);

        if (!this.isStreamingAudio)
            this.media.classList.remove('unmute-pending');

        this.setStatus('playing');

        this.eventTarget.dispatchEvent(new CustomEvent('volumechange', { detail: { muted: this.media.muted } }));
    }

    handleMediaVolumeChange() {
        if (this.media.tagName === 'AUDIO') {
            // Override default audio element behavior: mute controls play/pause
            if (this.media.muted)
                this.pauseMedia();
            else
                this.playMedia();

            if (this.state.activeCard && this.media.controls)
                this.state.activeCard.setControlsVisibility(true);
        }
        this.eventTarget.dispatchEvent(new CustomEvent('volumechange', { detail: { muted: this.media.muted } }));
    }

    handleMediaDblClick(ev) {
        // Prevent double fullscreen in Chrome
        ev.preventDefault();
        setTimeout(() => {
            if (this.state.activeCard)
                this.state.activeCard.setControlsVisibility(false);
        }, 100);
    }

    handleMediaClick() {
        WebRTCsession.enableUnmute();
        if (this.state.activeCard) {
            if (this.media.controls) {
                this.state.activeCard.setControlsVisibility(true);
            }
        }
    }

    handleMediaError() {
        this.lastError = this.media.error.message;
        this.trace(`Media error ${this.media.error.code}; details: ${this.media.error.message}`);
        this.setStatus('error');
    }

    endCall(call) {
        if (!call) return;

        if (!this.isTerminated)
            this.fetchImage()
                
        this.traceCall(call, 'Ending call');

        const sc = call.signalingChannel;
        if (sc) {
            call.signalingChannel = null;
            try {
                sc.close();
            } catch { this.traceCall(call, 'Error closing signaling channel'); }
        }

        this.closePeerConnection(call);
        
        const localStream = call.localStream;
        if (localStream) {
            call.localStream = null;
            localStream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    this.traceCall(call, 'Error stopping local stream track');
                }
            });
        }

        // Clean media prior to closing remote stream to prevent visual artifacts
        this.unloadRemoteMedia(call);

        const remoteStream = call.remoteStream;
        if (remoteStream) {
            call.remoteStream = null;
            remoteStream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    this.traceCall(call, 'Error stopping remote stream track');
                }
            });
        }

        this.state.call = null;
        this.traceCall(call, 'Call ended');
    }

    createCallId(now) {
        const seconds = Math.floor(now / 1000) % 60;
        const minutes = Math.floor(now / 60000) % 10000;
        const result = seconds.toString().padStart(2, '0') + minutes.toString().padStart(4, '0');
        return result;
    }

    traceCall(call, message)
    {
        this.trace(`${call.id}: ${message}`);
    }

    async startCall() {

        if (this.config.video === false && this.config.audio === false) {
            this.trace('WebRTC disabled');
            return;
        }

        const now = Date.now()
        const call = {
            id: this.createCallId(now),
            startDate: now,
            signalingChannel: null,
            peerConnection: null,
            localStream: null,
            remoteStream: null
        };

        if (this.state.call) {
            this.traceCall(call, `Terminating existing call ${this.state.call.id} before starting a new call.`);
            this.endCall(this.state.call);
        }
        
        this.state.call = call;

        this.traceCall(call, `Call started`);
        this.setStatus('connecting');
        this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);

        if (this.microphone) {
            // Acquire microphone for two-way audio
            if (window.isSecureContext && navigator.mediaDevices) {
                try {
                    call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                }
                catch (err) {
                    switch (err.name) {
                        case "NotFoundError":
                            this.traceCall(call, `No microphone found`);
                            break;
                        case "SecurityError":
                        case "PermissionDeniedError":
                        default:
                            this.traceCall(call, `Failed to open microphone. ${err.name}: ${err.message}`);
                            break;
                    }
                }
            }
        }

        await this.openSignalingChannel(call, this.config.url_type);
        this.createPeerConnection(call);

        if (call.localStream) {
            call.localStream.getTracks().forEach(track => {
                call.peerConnection.addTrack(track, call.localStream);
            });
        }

        if (this.config.video !== false)
            call.peerConnection.addTransceiver('video', { direction: 'recvonly' });
        if (this.config.audio !== false)
            call.peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        this.traceCall(call, "Added transceivers");

        let offer;
        try {
            offer = await call.peerConnection.createOffer();
        }
        catch (err) {
            switch (err.name) {
                case "InvalidStateError":
                    this.lastError = `Peer connection state is invalid`;
                    break;
                case "NotReadableError":
                    this.lastError = `Unable to establish secure peer connection`;
                    break;
                case "OperationError":
                default:
                    this.lastError = `Failed to create WebRTC offer. ${err.name}: ${err.message}`;
                    break;
            }
            this.traceCall(call, this.lastError);
            this.setStatus('error');
            this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ERROR);
            
            setTimeout(() => this.endCall(call), 0);
            return;
        }
        await call.peerConnection.setLocalDescription(offer);

        if (call.signalingChannel) {
            this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);
            call.signalingChannel.sendOffer(offer);
            this.traceCall(call, 'Sent offer');
        }
        else {
            this.traceCall(call, 'Cannot send offer. Signaling channel invalid');
        }
    }

    closePeerConnection(call) {
        const pc = call.peerConnection;
        if (pc) {
            pc.oniceconnectionstatechange = null;
            pc.onicecandidate = null;
            pc.ontrack = null;
            call.peerConnection = null;

            try {
                pc.close();
            } catch { this.traceCall(call, 'Error closing peer connection'); }
        }
    }

    createPeerConnection(call) {

        if (call.peerConnection) {
            this.traceCall(call, "Existing peer connection detected. Closing it before creating a new one.");
            this.closePeerConnection(call);
        }

        const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
        const pc = new RTCPeerConnection(config);

        pc.oniceconnectionstatechange = () => {
            this.traceCall(call, `ICE state: ${pc.iceConnectionState}`);

            const state = pc.iceConnectionState;
            switch (state) {
                case "connected":
                    // Connection established
                    break;
                case "failed":
                case "closed":
                case "disconnected":
                    this.restart(call);
                    break;
                // case "disconnected":
                //     // todo: shoudl this have bene removed?
                //     await this.unloadRemoteMedia();

                //     // // Wait for ICE reconnect 
                //     this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ICE);
                //     break;

            }
        }

        pc.onicecandidate = ev => {
            if (!call.signalingChannel?.isOpen) {
                this.traceCall(call, `Signaling channel closed, cannot send ICE candidate '${ev?.candidate?.candidate}'`);
                return;
            }

            if (ev.candidate) {
                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);
                call.signalingChannel.sendCandidate(ev.candidate);
                this.traceCall(call, `Sent ICE candidate '${ev.candidate.candidate}'`);
            }
            else {
                call.signalingChannel.sendCandidate();
                this.traceCall(call, 'Completed gathering ICE candidates');
            }
        }

        pc.ontrack = ev => {
            this.traceCall(call, 'Received track');

            if (!call.remoteStream) {
                call.remoteStream = new MediaStream();
                this.loadRemoteMedia(call);
            }

            call.remoteStream.addTrack(ev.track);
        }

        call.peerConnection = pc;
    }

    async openSignalingChannel(call, url_type = 'webrtc-babycam') {
        let url;
        let signalingChannel = null;

        if (url_type === 'go2rtc') {
            if (this.config.url) {
                let params = (new URL(this.config.url)).searchParams;
                if (params.has('src'))
                    url = `ws${this.config.url.substr(4).replace(/\/$/, '')}/api/ws?src=${params.get('src')}`;
                else
                    url = `ws${this.config.url.substr(4).replace(/\/$/, '')}/api/ws?src=${this.config.entity}`;

                signalingChannel = new Go2RtcSignalingChannel(url);
            }
        }

        else if (url_type === 'webrtc-babycam') {
            // Modified webrtc-babycam custom-component proxy

            url = '/api/webrtc/ws?';
            if (this.config.url)
                url += '&url=' + encodeURIComponent(this.config.url);
            if (this.config.entity)
                url += '&entity=' + encodeURIComponent(this.config.entity); // Added encodeURIComponent for safety

            const signature = await this.hass.callWS({
                type: 'auth/sign_path',
                path: url
            });

            if (signature?.path) {
                url = `ws${location.origin.substring(4)}${signature.path}`;
                signalingChannel = new Go2RtcSignalingChannel(url);
            }
        }

        else if (url_type === 'webrtc-camera') {
            const data = await this.hass.callWS({
                type: 'auth/sign_path',
                path: '/api/webrtc/ws'
            });

            if (data?.path) {
                url = 'ws' + this.hass.hassUrl(data.path).substring(4);
                if (this.config.url) {
                    url += '&url=' + encodeURIComponent(this.config.url); // Added encodeURIComponent for safety
                }
                if (this.config.entity) {
                    url += '&entity=' + encodeURIComponent(this.config.entity); // Added encodeURIComponent for safety
                }
                signalingChannel = new Go2RtcSignalingChannel(url);
            }
        }

        else if (url_type === 'whep') {
            if (this.config.url) {
                url = this.config.url;
                if (!url.includes('/whep'))
                    url += '/' + this.config.entity + '/whep';
            }

            signalingChannel = new WhepSignalingChannel(url, WebRTCsession.TIMEOUT_SIGNALING);
        }

        else if (url_type === 'rtsptoweb') {
            url = this.config.url;
            signalingChannel = new RTSPtoWebSignalingChannel(url, WebRTCsession.TIMEOUT_SIGNALING);
        }

        call.signalingChannel = signalingChannel;
        if (!signalingChannel) {
            this.lastError = `Invalid signaling configuration`;
            this.traceCall(call, this.lastError);
            this.setStatus('error');
            return;
        }

        try {
           

            signalingChannel.oncandidate = (candidate) => {
                if (candidate) {
                    this.traceCall(call, `Received ICE candidate '${candidate.candidate}'`);
                } else {
                    this.traceCall(call, 'Received end of ICE candidates');
                }
                try {
                    if (candidate)
                        call.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
                catch (err) { this.traceCall(call, `addIceCandidate error: ${err.name}:${err.message}`); }
            }

            signalingChannel.onanswer = async (answer) => {
                this.traceCall(call, "Received answer");
                try {
                    await call.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                    this.traceCall(call, `Remote description set`);
                    if (!call.peerConnection.canTrickleIceCandidates) {
                        this.traceCall(call, `Trickled ICE candidates unsupported`);
                    }
                } catch (err) {
                    this.lastError = err.message;
                    this.traceCall(call, this.lastError);
                    this.setStatus('error');
                    this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ERROR);
                }
            }

            signalingChannel.onerror = (err) => {
                this.traceCall(call, `Signaling error: ${err.message}`);
                this.lastError = err.message;
                this.traceCall(call, this.lastError);
                this.setStatus('error');
                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ERROR);
            }

            signalingChannel.ontrace = (message) => {
                this.traceCall(call, `${message}`);
            }

            await signalingChannel.open(WebRTCsession.TIMEOUT_SIGNALING);
            if (signalingChannel.isOpen) {
                this.traceCall(call, `Opened '${url}'`);
            }
            else {
                call.signalingChannel = null;
                this.lastError = `Failed to open signaling channel`;
                this.traceCall(call, this.lastError);
                this.setStatus('error');
            }

        } catch (err) {
            this.lastError = `Signaling channel error: ${err.message}`;
            this.traceCall(call, this.lastError);
            this.setStatus('error');
        }
    }

    /**
     * Method returns without new fetch if current image age is less than maximumCacheAge
     * @param {Number} maximumCacheAge milliseconds
     */
    async fetchImage(maximumCacheAge = 300) {
        if (this.fetchImageTimeoutId) return;
        if (maximumCacheAge > (Date.now() - this.state.image?.timestamp)) return;

        try {
            let url = null;
            if (this.config.entity && this.hass?.states && this.hass?.connected) {
                const entity = this.hass.states[this.config.entity];
                url = entity?.attributes?.entity_picture;
            }

            if (!url && this.config.poster) {
                url = this.config.poster;
            }

            if (!url) {
                this.trace(`Fetch image unable to define URL`);
                return;
            }

            try {
                const abort = new AbortController();
                this.fetchImageTimeoutId = setTimeout(() => {
                    abort.abort();
                    this.fetchImageTimeoutId = undefined;
                }, WebRTCsession.TIMEOUT_IMAGE);

                const response = await fetch(url,
                    { signal: abort.signal, cache: "no-store" }
                );

                if (response?.ok) {
                    clearTimeout(this.fetchImageTimeoutId);
                    this.setImage(await response.blob());
                }
            }
            finally {
                clearTimeout(this.fetchImageTimeoutId);
                this.fetchImageTimeoutId = undefined;
            }
        }
        catch (err) {
            switch (err.name) {
                case "AbortError":
                    this.trace(`Fetch image timeout`);
                    break;
                default:
                    this.trace(`Fetch image error: ${err.name}:${err.message}`);
                    break;
            }
        }
    }

    setImage(blob) {
        this.stats.imageBytesReceived += blob.size;

        const previousImage = this.state.image;
        const image = {
            blob: blob,
            size: blob.size,
            timestamp: Date.now()
        };
        this.state.image = image;
        this.eventTarget.dispatchEvent(new CustomEvent('imagechange', { detail: { image: image } }));

        if (previousImage) {
            this.trace(`Image updated after ${image.timestamp - previousImage.timestamp}ms`);
        }
        else {
            this.trace(`Image updated`);
        }
    }

    async createThumbnail(width, height) {
        const blob = this.state.image?.blob;
        if (!blob) return null;

        return new Promise((accept, reject) => {
            const image = new Image();
            image.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
                const scaledHeight = image.naturalHeight * scale;
                const scaledWidth = image.naturalWidth * scale;
                const type = "image/png";

                canvas.getContext('2d').drawImage(image,
                    (width - scaledWidth) / 2,
                    (height - scaledHeight) / 2,
                    scaledWidth,
                    scaledHeight
                );
                URL.revokeObjectURL(image.src);

                const thumbnail = {
                    src: canvas.toDataURL(type),
                    width: width,
                    height: height,
                    type: type
                }
                accept(thumbnail);
            };
            image.onerror = () => {
                reject(new Error('Failed to load image for thumbnail'));
            };
            image.src = URL.createObjectURL(blob);
        });
    }
}

/////////////////////////////////////////////////////////////

/**
 * WebRTCbabycam Custom Element
 */
class WebRTCbabycam extends HTMLElement {

    constructor() {
        super();
        this.waitStartDate = null;
        this.session = null;
        this.isVisibleInViewport = false;
        this.globalEventHandlersRegistered = false;  
        this.cardConfig = null;

        // Bind handler methods to ensure correct 'this' context
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        this.handleWindowFocus = this.handleWindowFocus.bind(this);
        this.handleDocumentVisibility = this.handleDocumentVisibility.bind(this);
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
    }

    get media() {
        return this.session?.media;
    }

    get config() {
         return this.session?.config;
    }

    set header(text) {
        const header = this.shadowRoot.querySelector('.header');
        if (header) {
            header.innerHTML = text;
            header.style.display = text ? 'block' : 'none';
        }
    }

    get header() {
        const header = this.shadowRoot.querySelector('.header');
        return header ? header.innerHTML : '';
    }

    toggleDebug() {
        this.setDebugVisibility(!this.config.debug);
    }

    setDebugVisibility(show) {
     
        this.config.debug = show;
        const log = this.shadowRoot.querySelector('.log');
        if (show) {
            this.session.tracing = true;
            log.classList.remove('hidden');
            
        }
        else {
            log.classList.add('hidden');
            log.innerHTML = '';
          
        }
    }

    async setControlsVisibility(show) {
        const timeout = 3000;
        const media = this.media;
        if (!media) return;

        const showActive = () => {
            return Date.now() < Number(media?.getAttribute('show')) + timeout
                || (media?.tagName == 'VIDEO' && media?.getAttribute('playing') === 'paused');
        }

        const ptzShowing = this.shadowRoot.querySelector('.ptz')?.hasAttribute('show') || false;
        if (show) {
            this.setPTZVisibility(false);

            if (showActive()) {
                media.setAttribute('show', Date.now());
                return;
            }
            media.setAttribute('show', Date.now());
            media.controls = true;
            while (showActive()) {
                // Controls remain active while media paused
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
        media.removeAttribute('show');
        media.controls = false;
        this.setPTZVisibility(ptzShowing);
    }

    setPTZVisibility(show) {
        const timeout = 4000;
        const ptz = this.shadowRoot.querySelector('.ptz');
        const timer = ptz?.getAttribute('show');
        if (timer) {
            clearTimeout(Number(timer)); 
            ptz.removeAttribute('show');
        }

        if (show) {
            ptz.setAttribute('show',
                setTimeout(() => { this.setPTZVisibility(false) }, timeout));
        }
    }
 
    renderCard() {
        const shadowRoot = this.attachShadow({ mode: 'open' });
 
        shadowRoot.innerHTML = `
        <style>
            ha-card {
                display: flex;
                justify-content: center;
                flex-direction: column;
                margin: auto;
                overflow: hidden;
                width: 100%;
                height: 100%;
                position: relative;
                border-radius: 0px;
                border-style: none;
            }
            .media-container {
                background: var(--primary-background-color);
            }
            video {
                visibility: hidden;
                position: absolute;
                left: 0;
                right: 0;
                top: 0;
                bottom: 0;
                margin: auto;
                width: 100%;
                background: transparent;
            }
            video[playing="audiovideo"], video[playing="video"]
            {
                visibility: visible;
                z-index: 2;
            }
            .image:not([size]) ~ video {
                /* video style when image blank */
                position: static;
                display: block;
                width: 100%;
                height: 100%;
            }
            audio {
                visibility: hidden;
                position: absolute;
                left: 0;
                right: 0;
                top: 0;
                bottom: 0;
                margin: auto;
            }
            audio[controls] {
                visibility: visible;
                opacity: 0.8;
                transition: visibility 0.3s linear, opacity 0.3s linear;
                z-index: 2;
            }
            audio:hover {
                opacity: 1;
            }
            .image {
                display: none;
                width: 100%;
                height: 100%;
                -webkit-touch-callout: none;
                z-index: 1;
            }
            .image[size] {
                display: block;
            }
            .hidden {
                visibility: hidden !important;
                opacity: 0;
            }
            .box {
                position: absolute;
                left: 0px;
                right: 0px;
                top: 0px;
                background-color: rgba(0, 0, 0, 0.3);
                pointer-events: none;
                z-index: 3;
            }
            .header {
                color: var(--ha-picture-card-text-color, white);
                margin: 14px 16px;
                display: none;
                font-size: 16px;
                line-height: 20px;
                word-wrap: break-word;
            }
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(359deg); }
            }  
            .state {
                visibility: hidden;
                color: white;
                position: absolute; 
                right: 12px;
                top: 12px;
                cursor: default;
                opacity: 0;
                transition: visibility 300ms linear, opacity 300ms linear;
                transition-delay: 0.8s;
                pointer-events: none;
                z-index: 4;
            }
            .state[error] {
                visibility: visible;
                opacity: 1;
                pointer-events: all;
            } 
            .state[icon="mdi:loading"] {
                animation: spin 1s linear infinite;
            }  
            .state[icon*="mdi:volume"] {
                pointer-events: all;
                cursor: pointer;
            }  
            .visible {
                visibility: visible;
            }
            .show {
                visibility: visible;
                opacity: 1;
                transition: visibility 0ms ease-in-out 0ms, opacity 300ms !important; 
            }
            .log {
                color: #ffffff;
                position: absolute;
                left: 0;
                right: 0;
                top: 0;
                bottom: 0;
                display: block;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,.4); 
                pointer-events: none;
                z-index: 6;
                overflow-y: scroll;
                overflow-x: hidden;
                white-space: nowrap;
                line-height: 1;
                font-size: .5vw;
            } 
            .log.pointerevents {
                pointer-events: all;
            }
        </style>
        <ha-card class="card">
            <div class="media-container">
                <img class="image" alt>
                <ha-icon class="state"></ha-icon>
            </div>
            <div class="box">
                <div class="header"></div>
            </div>
            <div class="log hidden"></div>
        </ha-card>
        `;
    }

    renderPTZ() {
        const hasMove = this.config.ptz?.data_right;
        const hasZoom = this.config.ptz?.data_zoom_in;
        const hasHome = this.config.ptz?.data_home;
        const hasVol = this.config.audio !== false;
        const hasMic = this.config.microphone;

        const ptzHeight = 10 + (hasMove ? 80 : 0) + 10 + (hasZoom ? 40 : 0) + 10 + (hasHome ? 40 : 0) + 10 + (hasVol ? 80 : 0) + 10 + (hasMic ? 80 : 0) + 10;
        const ptzMaxHeight = 100 + (4 * 80) + 100;

        //this.style.setProperty('--ptz-height',ptz.getBoundingClientRect().height + 'px');

        const card = this.shadowRoot.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                :host {
                    --ptz-height: ${ptzHeight}px;
                    --ptz-maxHeight: ${ptzMaxHeight}px;
                    --ptz-button-size: 40px;
                    --ptz-button-large-size: 80px;
                    --ptz-button-background: rgba(0, 0, 0, 0.4);
                    --ptz-button-opacity: ${parseFloat(this.config.ptz?.opacity) || 0.6};
                }
                .right-sidebar {
                    position: absolute;
                    top: 50%;
                    right: 10px;
                    transform: translateY(-50%);
                    z-index: 5;
                }
                .ptz {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    opacity: var(--ptz-button-opacity);
                    visibility: hidden;
                    transform: scale(var(--ptz-scale, 1));
                    transform-origin: 100% 50%;
                    transition: visibility 0.3s linear, opacity 0.3s linear;
                }
                .ptz[show]  
                {
                    visibility: visible;
                }
                @media (pointer: coarse) { 
                    .ptz { opacity: 1; }
                }
                .ptz:hover {
                    opacity: 1;
                }
                .ptz-move {
                    position: relative;
                    background-color: var(--ptz-button-background);
                    border-radius: 50%;
                    width: var(--ptz-button-large-size);
                    height: var(--ptz-button-large-size);
                    display: ${hasMove ? 'block' : 'none'};
                }
                .ptz-zoom {
                    position: relative;
                    width: calc(var(--ptz-button-size) * 2);
                    height: var(--ptz-button-size);
                    background-color: var(--ptz-button-background);
                    border-radius: 4px;
                    display: ${hasZoom ? 'block' : 'none'};
                }
                .ptz-home {
                    position: relative;
                    width: var(--ptz-button-size);
                    height: var(--ptz-button-size);
                    background-color: var(--ptz-button-background);
                    border-radius: 4px;
                    align-self: center;
                    display: ${hasHome ? 'block' : 'none'};
                    cursor: pointer;
                }  
                .ptz-volume {
                    position: relative;
                    background-color: var(--ptz-button-background);
                    border-radius: 50%;
                    width: var(--ptz-button-large-size);
                    height: var(--ptz-button-large-size);
                    left: 0px;
                    display: ${hasVol ? 'block' : 'none'};
                    cursor: pointer;
                }
                .ptz-microphone {
                    position: relative;
                    background-color: var(--ptz-button-background);
                    border-radius: 50%;
                    width: var(--ptz-button-large-size);
                    height: var(--ptz-button-large-size);
                    left: 0px;
                    display: ${hasMic ? 'block' : 'none'};
                    cursor: pointer;
                }
                .up {
                    position: absolute;
                    top: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .down {
                    position: absolute;
                    bottom: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .left {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .right {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_out {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_in {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .home {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
                .volume {
                    position: absolute; 
                    top: 50%;
                    transform: translateY(-50%);
                    margin-left: auto;
                    margin-right: auto;
                    left: 0;
                    right: 0;
                    text-align: center;
                }
                .microphone {
                    position: absolute; 
                    top: 50%;
                    transform: translateY(-50%);
                    margin-left: auto;
                    margin-right: auto;
                    left: 0;
                    right: 0;
                    text-align: center;
                }
                .ptz ha-icon {
                    color: white;
                    position: absolute;
                    cursor: pointer;
                }
            </style>
        `);

        card.insertAdjacentHTML('beforeend', `
            <div class="right-sidebar">
                <div class="ptz">
                    <div class="ptz-move">
                        <ha-icon class="right" icon="mdi:arrow-right"></ha-icon>
                        <ha-icon class="left" icon="mdi:arrow-left"></ha-icon>
                        <ha-icon class="up" icon="mdi:arrow-up"></ha-icon>
                        <ha-icon class="down" icon="mdi:arrow-down"></ha-icon>
                    </div>
                    <div class="ptz-zoom">
                        <ha-icon class="zoom_in" icon="mdi:plus"></ha-icon>
                        <ha-icon class="zoom_out" icon="mdi:minus"></ha-icon>
                    </div>
                    <div class="ptz-home">
                        <ha-icon class="home" icon="mdi:home"></ha-icon>
                    </div>
                    <div class="ptz-volume">
                        <ha-icon class="volume" icon="null"></ha-icon>
                    </div>
                    <div class="ptz-microphone">
                        <ha-icon class="microphone" icon="null"></ha-icon>
                    </div>
                </div>
            </div>
        `);
    }

    renderShortcuts() {
        if (!this.config.shortcuts) return;
        const card = this.shadowRoot.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
        <style>
            .shortcuts {
                position: absolute;
                top: 5px;
                left: 5px;
                z-index: 5;
            }
            .shortcuts ha-icon {
                color: white;
                position: absolute;
                cursor: pointer;
            }
        </style>
        `);

        // backward compatibility with `services` property
        const services = this.config.shortcuts.services || this.config.shortcuts;
        const icons = services.map((value, index) =>
            `<ha-icon data-index="${index}" icon="${value.icon}" title="${value.name}"></ha-icon>`
        ).join("");

        card.insertAdjacentHTML('beforeend', `
        <div class="shortcuts">${icons}</div>
        `);
    }

    renderStyle() {
        if (!this.config.style) return;

        const style = document.createElement('style');
        style.innerText = this.config.style;
        const card = this.shadowRoot.querySelector('.card');
        card.insertAdjacentElement('beforebegin', style);
    }

    static globalInit() {
        if (WebRTCbabycam.initialStaticSetupComplete) 
            return;

        const handleKeyUp = (ev) => {
            WebRTCsession.enableUnmute();

            const unmute = "KeyT";
            const debug = "KeyD";

            const shiftA = "ShiftRight";
            const shiftB = "ShiftLeft";
            const shiftC = "ShiftKey";

            const iterator = WebRTCsession.sessions.values();
            for (const session of iterator) {
                switch (ev.code) {
                    case unmute:
                        session.unmuteMedia();
                        break;

                    case debug:
                        if (session.state.activeCard)
                            session.state.activeCard.toggleDebug();
                        break;

                    case shiftA:
                    case shiftB:
                    case shiftC:
                        if (session.state.activeCard)
                            session.state.activeCard.shadowRoot.querySelector('.log')?.classList.remove('pointerevents');
                        break
                }
            }
        }

        const handleKeyDown = (ev) => {
            const shiftA = "ShiftRight";
            const shiftB = "ShiftLeft";
            const shiftC = "ShiftKey";

            const iterator = WebRTCsession.sessions.values();
            for (const session of iterator) {
                switch (ev.code) {
                    case shiftA:
                    case shiftB:
                    case shiftC:
                        if (session.state.activeCard && session.state.activeCard.debugEnabled)
                            session.state.activeCard.shadowRoot.querySelector('.log')?.classList.add('pointerevents');
                        break;
                }
            }
        }

        // Uncomment if zoom library is needed
        // const loadScript = async (src) => {
        //     const s = document.createElement('script');
        //     s.src = src;
        //     document.head.appendChild(s);
        // }
        // loadScript('https://anitasv.github.io/zoom/zoom-1.0.7.min.js');

        document.addEventListener('keyup', handleKeyUp, true);
        document.addEventListener('keydown', handleKeyDown, true);

        WebRTCbabycam.initialStaticSetupComplete = true;
    }

    registerRenderComponentEventListeners(){
        
        const container = this.shadowRoot.querySelector('.media-container');
        const image = this.shadowRoot.querySelector('.image');
        const ptz = this.shadowRoot.querySelector('.ptz');
        const shortcuts = this.shadowRoot.querySelector('.shortcuts');
        const state = this.shadowRoot.querySelector('.state');

        if (container) {
            container.addEventListener('mousemove', () => {
                if (this.media?.controls)
                    this.setControlsVisibility(true);
                else
                    this.setPTZVisibility(true);
            });

            if (document.fullscreenEnabled) {
                this.onDoubleTap(container, () => this.toggleFullScreen());
                this.onMouseDoubleClick(container, () => this.toggleFullScreen());
            }

            this.onMouseDownHold(container, () => this.setControlsVisibility(true), 800);
            this.onTouchHold(container, () => this.setControlsVisibility(true), 800);
        }

        const ptzStyle = window.getComputedStyle(ptz);
        const ptzHeight = Number(ptzStyle.getPropertyValue("--ptz-height").replace('px', ''));
        const ptzMaxHeight = Number(ptzStyle.getPropertyValue("--ptz-maxHeight").replace('px', ''));

        const resize = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { inlineSize: width, blockSize: availableheight } = entry.contentBoxSize[0];
                if (availableheight > 0) {
                    let scale;
                    if (ptzHeight > availableheight)
                        // scale down to fit
                        scale = availableheight / ptzHeight;
                    else if (window.matchMedia("(pointer: fine)").matches)
                        // actual size
                        scale = 1;
                    else
                        // scale up to 1/2
                        scale = Math.max((availableheight / 2) / ptzHeight, 1); //  availableheight / Math.max(ptzMaxHeight, 400));

                    this.style.setProperty(`--ptz-scale`, `${scale}`);
                }
            }
        });
        resize.observe(container);
        this.resizeObserver = resize;

        
        if (image) {
            image.addEventListener('click', () => this.session.fetchImage());
            this.onMouseDownHold(image, () => this.session.fetchImage(), 800, 1000);
            this.onTouchHold(image, () => this.session.fetchImage(), 800, 1000);
        }

        if (ptz) {
            ptz.addEventListener('click', ev => this.buttonClick(ev.target));
            ptz.addEventListener('mousedown', () => this.setPTZVisibility(true));
            ptz.addEventListener('mouseup', () => this.setPTZVisibility(true));
            ptz.addEventListener('mousemove', () => {
                this.setPTZVisibility(true);
                this.setControlsVisibility(false);
            }, true);

            ptz.querySelectorAll('ha-icon').forEach(button => {
                this.onMouseDownHold(button, () => this.buttonClick(button), 800, 500);
                this.onTouchHold(button, () => this.buttonClick(button), 800, 500);
            });
        }

        if (shortcuts) {
            shortcuts.addEventListener('click', ev => { this.buttonClick(ev.target) });
        }

        if (state) {
            state.addEventListener('click', ev => { this.buttonClick(ev.target) });
        }

        // Event listeners for session events
        this.session.eventTarget.addEventListener('statuschange', ev => this.updateStatus());
        this.session.eventTarget.addEventListener('backgroundchange', ev => this.updateVolume());
        this.session.eventTarget.addEventListener('volumechange', ev => this.updateVolume());
        this.session.eventTarget.addEventListener('microphonechange', ev => this.updateMicrophone(ev.detail.microphone));
        this.session.eventTarget.addEventListener('imagechange', ev => this.updateImage(ev.detail.image));
        this.session.eventTarget.addEventListener('trace', ev => this.trace(ev.detail.message));
        if (!this.errorHandler) {
            this.errorHandler = (err) => {
                let message;
                if (err.stack)
                    message = err.stack;
                else
                    message = `${err.name}:${err.message}\n at ${err.filename}:${err.lineno}:${err.colno}`;
                this.session.trace(message);
            }
        }
        window.addEventListener("error", this.errorHandler);
        window.removeEventListener("error", this.errorHandler);
    }

    /**
     * Prevent event from propagating further
     * @param {Event} ev 
     */
    stopImmediatePropagation(ev) {
        ev.stopImmediatePropagation();
    }

    /**
     * Register callback for hold main mouse button down
     * @param {Element} element Mouse target element 
     * @param {Function} callback Callback method
     * @param {Number} ms Minimum hold duration 
     * @param {Number} repeatDelay Milliseconds before callback is called again
     */
    onMouseDownHold(element, callback, ms = 500, repeatDelay = undefined) {
        const attribute = 'mousedown';
        const cancel = (ev) => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        }

        element.addEventListener('mousedown', ev => {
            if (ev.button != 0) return;
            element.removeEventListener('click', this.stopImmediatePropagation, { capture: true, once: true });
            if (element.hasAttribute(attribute)) cancel();

            const timer = setTimeout(async () => {
                element.addEventListener('click', this.stopImmediatePropagation, { capture: true, once: true });
                if (repeatDelay) {
                    while (element.hasAttribute(attribute)) {
                        callback();
                        await new Promise(resolve => setTimeout(resolve, repeatDelay));
                    }
                }
                else {
                    element.removeAttribute(attribute);
                    callback();
                }
            }, ms);
            element.setAttribute(attribute, timer);
        });

        element.addEventListener('mouseup', cancel);
        element.addEventListener('pointerout', cancel);
    }

    /**
     * Register callback for tap hold touch
     * @param {Element} element Touch target element
     * @param {Function} callback Callback method
     * @param {Number} ms Minimum hold duration 
     * @param {Number} repeatDelay Milliseconds before callback is called again
     */
    onTouchHold(element, callback, ms = 500, repeatDelay = undefined) {
        const attribute = 'hold';
        const cancel = () => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        }
        element.addEventListener('touchstart', (ev) => {
            element.removeEventListener('click', this.stopImmediatePropagation, { capture: true, once: true });
            if (element.hasAttribute(attribute)) cancel();
            if (ev.touches.length > 1) {
                // Multi-touch cancels hold
                cancel();
                return;
            }
            const timer = setTimeout(async () => {
                element.addEventListener('click', this.stopImmediatePropagation, { capture: true, once: true });
                if (repeatDelay) {
                    while (element.hasAttribute(attribute)) {
                        callback();
                        await new Promise(resolve => setTimeout(resolve, repeatDelay));
                    }
                }
                else {
                    element.removeAttribute(attribute);
                    callback();
                }
            }, ms);
            element.setAttribute(attribute, timer);
        }, { passive: true });

        element.addEventListener('touchend', cancel);
        element.addEventListener('pointerout', cancel);
    }

    /**
     * Register callback for double tap touch.
     * Double tap stops immediate propagation of event capture and bubbling
     * @param {Element} element Touch target element 
     * @param {Function} doubleTapCallback Callback method
     * @param {Number} ms Maximum milliseconds between first and double tap
     */
    onDoubleTap(element, doubleTapCallback, ms = 500) {
        const attribute = 'doubletap';
        const cancel = () => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        }
        element.addEventListener('touchend', (ev) => {
            if (ev.touches.length > 0) {
                // Multi-touch cancels double tap
                cancel();
                return;
            }
            if (element.hasAttribute(attribute)) {
                if (doubleTapCallback) {
                    // Prevent click
                    ev.preventDefault();
                    doubleTapCallback();
                }
                cancel();
                return;
            }
            const timer = setTimeout(() => cancel(), ms);
            element.setAttribute(attribute, timer);
        }, true);
    }

    /**
     * Register callback for double click with the main mouse button. 
     * Double mouse click stops immediate propagation of event capture and bubbling
     * @param {Element} element Mouse target element 
     * @param {Function} doubleClickCallback Callback method
     * @param {Number} ms Maximum milliseconds between first and double click
     */
    onMouseDoubleClick(element, doubleClickCallback, ms = 500) {
        const attribute = 'doubleclick';
        const cancel = () => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        }
        element.addEventListener('click', ev => {
            if (ev.pointerType !== "mouse" || ev.button !== 0) return;
            if (element.hasAttribute(attribute)) {
                if (doubleClickCallback) {
                    this.stopImmediatePropagation(ev);
                    doubleClickCallback();
                }
                cancel();
                return;
            }
            const timer = setTimeout(() => cancel(), ms);
            element.setAttribute('doubleclick', timer);
        }, true);
    }

    execute(action, params) {
        switch (action) {

            case 'debug':
                this.toggleDebug();
                break;

            case 'fullscreen':
                this.toggleFullScreen();
                break;

            case 'microphone':
                this.session.microphone = !this.session.microphone;
                break;

            case 'play':
                this.session.playMedia();
                break;

            case 'ptz':
                if (params && params.domain && params.service) {
                    this.session.hass.callService(params.domain, params.service, params.data);
                    setTimeout(() => { this.session.fetchImage() }, 2000);
                }
                break;

            case 'shortcut':
                if (params && params.domain && params.service) {
                    this.session.hass.callService(params.domain, params.service, params.data);
                }
                break;

            case 'volume':
                this.session.toggleVolume();
                break;
        }
    }

    buttonClick(button) {
        this.setPTZVisibility(true);

        if (button.icon === 'mdi:volume-high'
            || button.icon === 'mdi:volume-off'
            || button.icon === 'mdi:pin'
            || button.icon === 'mdi:pin-off'
            || button.classList.contains('ptz-volume')) { // Changed to classList.contains
            this.execute('volume');
            return;
        }

        if (button.icon === 'mdi:microphone'
            || button.icon === 'mdi:microphone-off'
            || button.classList.contains('ptz-microphone')) { // Changed to classList.contains
            this.execute('microphone');
            return;
        }

        if (button.icon === 'mdi:pause') { // Consistent state management
            this.execute('play');
            return;
        }

        if (button.dataset.index !== undefined) { // Changed condition to check for undefined
            const shortcuts = this.config.shortcuts.services || this.config.shortcuts;
            const shortcut = shortcuts[button.dataset.index];
            if (shortcut && shortcut.service) { // Added check for shortcut.service
                const [domain, service] = shortcut.service.split('.', 2);
                this.execute('shortcut', { domain: domain, service: service, data: (shortcut.service_data || {}) });
            }
            return;
        }

        const ptzData = this.config.ptz['data_' + button.className];
        if (ptzData) {
            const [domain, service] = this.config.ptz.service.split('.', 2);
            this.execute('ptz', { domain: domain, service: service, data: ptzData });
            return;
        }
    }

    setIcon(newIcon, visible = undefined, errorMessage = undefined) {
        const stateIcon = this.shadowRoot.querySelector('.state');
        if (!stateIcon) return;

        if (errorMessage) {
            stateIcon.setAttribute("error", "");
            stateIcon.title = errorMessage;
        }
        else {
            stateIcon.removeAttribute("error");
            stateIcon.title = "";
        }

        const currentIcon = stateIcon.getAttribute('icon');
        if (newIcon != currentIcon) {  
            stateIcon.icon = newIcon;
            stateIcon.setAttribute('icon', newIcon);
        }

        if (visible || stateIcon.hasAttribute("error"))
            stateIcon.classList.add('show');
        else
            stateIcon.classList.remove('show');
    }

    updateStatus() {

        let status = null;

        if (!this.session || !this.session.status) {
            this.setIcon("mdi:heart-broken", false, null);
            this.updateImage(null);
            return;
        }
        else if (this.session.isTerminated === true)  {
            status = 'terminated';
            this.updateImage(null);
        }
        else if (this.config?.video === false && this.config?.audio === false) {
            // play status isn't applicable to image-only mode
            return;
        } 
        else {
            status = this.session.status
        }

        const media = this.media;
        const waitedTooLong = WebRTCsession.TIMEOUT_RENDERING;
        let iconToShow = null;
        
        switch (status) {
            case "reset":
                this.waitStartDate = Date.now();
                this.setIcon(null, false);
                return;

            case "terminated":
                this.setIcon("mdi:emoticon-dead", false, null);
                return;

            case "error":
                this.header = this.session.lastError;
                this.setIcon("mdi:alert-circle", true, this.session.lastError);
                return;

            case "disconnected":
                if (!this.waitStartDate)
                    this.waitStartDate = Date.now();
                // fall through to "connecting"

            case "connecting":
                iconToShow = (media?.tagName === 'AUDIO') ? "mdi:volume-mute" : "mdi:loading";

                setTimeout(() => {
                    this.updateStatus()
                }, waitedTooLong);
                break;

            case "paused":
                iconToShow = (media?.tagName === 'AUDIO') ? "mdi:volume-off" : "mdi:pause";
                break;

            case "playing":
                this.waitStartDate = null;
                this.header = "";
                this.setIcon(null, false);

                iconToShow = (media?.tagName === 'AUDIO') ? "mdi:volume-high" : "mdi:play";
                break;

            default:
                return;
        }

        if (this.session.isStreaming && media) {
            if (media.tagName == 'AUDIO') {
                if (this.session.background) 
                    this.setIcon("mdi:pin", true);
                else if (media.muted && (this.config.muted === false || this.session.background))
                    this.setIcon(iconToShow, true);
                else if (!media.muted && this.config.muted === true)
                    this.setIcon(iconToShow, true);
                else
                    this.setIcon(iconToShow, false);
            }
            else {
                switch (media.getAttribute('playing')) {
                    case 'paused':
                        this.setIcon(iconToShow, true);
                        break;
                    case 'video':
                        this.setIcon(iconToShow, false);
                        break;
                    case 'audiovideo':
                        if (media.muted && this.config.muted === false) 
                            this.setIcon("mdi:volume-mute", true);
                        else if (this.session.background) 
                            this.setIcon("mdi:pin", true);
                        else if (!media.muted && this.config.muted === true) 
                            this.setIcon("mdi:volume-high", true);
                        else 
                            this.setIcon(iconToShow, false);
                        break;
                    default:
                        break;
                }
            }
        }
        else {
            // We’re not currently streaming, or the ICE connection hasn't started
            // Show an icon only if we have indeed waited too long
            if (this.waitStartDate && (Date.now() >= this.waitStartDate + waitedTooLong)) {
              // The stream took too long => show the icon now
              this.setIcon(iconToShow, true);
            } else {
              // Not yet at the threshold => hide the icon
              this.setIcon(iconToShow, false);
            }
        }
    }

    updateImage(data) {
        const image = this.shadowRoot.querySelector('.image');
        if (image.getAttribute('timestamp') === data?.timestamp) return;

        if (!data) {
            image.removeAttribute('size');
            image.removeAttribute('timestamp');
            image.src = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E";
            return;
        }

        image.addEventListener('load', () => { if (image.hasAttribute('timestamp')) URL.revokeObjectURL(image.src) }, { once: true });
        image.setAttribute('timestamp', data.timestamp);
        image.setAttribute('size', data.size);
        image.src = URL.createObjectURL(data.blob);
    }

    updateVolume() {
        const volume = this.shadowRoot.querySelector('.volume');
        if (!volume) return;
        let icon = null;
        if (this.session.background === true) {
            icon = 'mdi:pin';
        }
        else if (this.config.audio === false || (this.session.isStreaming && !this.session.isStreamingAudio))  {
            // No audio available

            if (this.config.background === true || this.config.allow_background === true)
                icon = 'mdi:pin-off';
        }
        else if (this.media?.tagName === 'AUDIO') {
            if (!this.session.isStreamingAudio || this.media.muted)  
                icon = 'mdi:volume-off';
            else
                icon = 'mdi:volume-high';
        }
        else if (this.session.isStreaming && this.media) {
            if (this.media.muted)  
                icon = 'mdi:volume-off';
            else
                icon = 'mdi:volume-high';
        }

        volume.icon = icon;
        if (volume.icon) 
            volume.parentNode.classList.remove('hidden');
        else
            volume.parentNode.classList.add('hidden');

        this.updateStatus();
    }

    updateMicrophone(enabled) {
        const mic = this.shadowRoot.querySelector('.microphone');
        if (!mic) return;
        if (enabled) {
            mic.icon = 'mdi:microphone';
        }
        else {
            mic.icon = 'mdi:microphone-off';
        }
    }

    trace(message) {
        if (this.config.debug) {
            const log = this.shadowRoot.querySelector('.log');
            
            const max_entries = this.config.debug ? 1000 : 100;
            const min_entries = max_entries/2;

            log.insertAdjacentHTML('beforeend', message.replace("\n", "<br>") + '<br>');
            if (log.childNodes.length > max_entries) {  
                while (log.childNodes.length > min_entries) {
                    log.removeChild(log.firstChild);
                }
            } 
            if (this.config.debug) {
                log.scrollTop = log.scrollHeight;
            }
        }
    }

    toggleFullScreen() {
        if (!document.fullscreenEnabled) return;
        if (!document.fullscreenElement) {
            this.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }

    getCardSize() {
        return 5;
    }

    
    setConfig(config) {

        WebRTCbabycam.globalInit();
        this.assertConfigValid(config);
        
        this.cardConfig = config;
        
        let key = WebRTCsession.key(config);
        this.session = WebRTCsession.sessions.get(key); 
        if (!this.session) {
            const configClone = JSON.parse(JSON.stringify(config));
            this.session = WebRTCsession.create(configClone);
        }

        if (!this.rendered)
        {
            this.renderCard();
            this.renderPTZ();
            this.renderShortcuts();
            this.renderStyle();
            this.registerRenderComponentEventListeners()
            this.rendered = true
        }
    }

    assertConfigValid(config) {
        if (!('RTCPeerConnection' in window) && (config.video !== false || config.audio !== false)) {
            throw new Error("Browser does not support WebRTC"); // macOS Desktop app
        }
        if (!config.url || !config.entity) {
            throw new Error("Missing `url` or `entity`");
        }
        if (config.ptz && !config.ptz.service) {
            throw new Error("Missing `service` for `ptz`");
        }
    }

    set hass(hass) {
        this.session.hass = hass;
    }
   
    handleVisibilityChange() {
        this.visible = this.isVisibleInViewport;

        if (this.visible) {
            this.updateImage(this.session.state.image);
            this.session.attachCard(this);
            this.updateVolume();
            this.updateStatus();
            this.updateMicrophone(this.session.microphone);
        }
        else {
            this.setControlsVisibility(false);
            this.setPTZVisibility(false);
            this.session.detachCard(this);
            if (!this.session.background) this.waitStartDate = null;
        }
    }

    handleWindowFocus() {
        // Manually trigger the intersection observer's callback with the current state
        const entries = this.visibilityObserver.takeRecords(); // Get the list of entries on which the observer callback has not been executed.
        if (entries.length) {
            this.updateVisibility(entries);
        } else {
            // Optionally force a recheck if no entries are available
            this.visibilityObserver.unobserve(this);
            this.visibilityObserver.observe(this);
        }
    }
    
    handleDocumentVisibility() {
        if (document.hidden) {
            this.isVisibleInViewport = false;
            this.handleVisibilityChange();  
        }
    }

    handleDocumentClick() {
        WebRTCsession.enableUnmute();
    }
   
    registerEventListeners() {
        
        if (this.globalEventHandlersRegistered) return;
        this.globalEventHandlersRegistered = true;

        // Intersection Observer for visibility changes
        this.updateVisibility = (entries) => {
            this.isVisibleInViewport = entries[entries.length - 1].isIntersecting;
            if (document.fullscreenElement) return;
            this.handleVisibilityChange();
        };

        this.visibilityObserver = new IntersectionObserver(this.updateVisibility, { threshold: 0 });
        this.visibilityObserver.observe(this);

        document.addEventListener("visibilitychange", this.handleDocumentVisibility);
        window.addEventListener('focus', this.handleWindowFocus);
        document.addEventListener('click', this.handleDocumentClick, { once: true, capture: true });


    }


    cleanupEventListeners() {
        
        if (!this.globalEventHandlersRegistered) return;
        this.globalEventHandlersRegistered = false;

        // Clean up event listeners to prevent memory leaks
        if (this.visibilityObserver) {
            this.visibilityObserver.disconnect();
            this.visibilityObserver = null;
        }
      
        document.removeEventListener("visibilitychange", this.handleDocumentVisibility);
        window.removeEventListener('focus', this.handleWindowFocus);
        document.removeEventListener('click', this.handleDocumentClick, { once: true, capture: true });
    }


    init() {
        if (!this.config || !this.session?.hass?.connection) return;

        setTimeout(() => {
            this.registerEventListeners();
            this.setDebugVisibility(this.config.debug);
            this.setControlsVisibility(false);
            this.setPTZVisibility(false);

            this.session.fetchImage();
           
        });
    }
    
    connectedCallback() {
        this.init();  
    }

    disconnectedCallback() {
        this.isVisibleInViewport = false;
        this.handleVisibilityChange() 
        this.cleanupEventListeners()
    }

}

customElements.define('webrtc-babycam', WebRTCbabycam);

// Register the card for Home Assistant
const customCardRegistrationFinal = {
    type: 'webrtc-babycam',
    name: 'WebRTC Baby Camera',
    preview: false,
    description: 'WebRTC babycam provides a lag-free 2-way audio, video, and image camera card to monitor your favorite infant, nanny, or pet',
};
// Apple iOS 12 doesn't support `||=`
if (window.customCards) window.customCards.push(customCardRegistrationFinal);
else window.customCards = [customCardRegistrationFinal];


///////////////////////////////////////////////////////////////

class SignalingChannel {
    constructor() {
        this._oncandidate = null;
        this._onanswer = null;
        this._onoffer = null;
        this._onerror = null;
        this._ontrace = null;
    }
    async open(timeout) { }
    close() { }
    get isOpen() { return false; }
    get oncandidate() { return this._oncandidate; }
    set oncandidate(fn) { this._oncandidate = fn; }
    get onanswer() { return this._onanswer; }
    set onanswer(fn) { this._onanswer = fn; }
    get onoffer() { return this._onoffer; }
    set onoffer(fn) { this._onoffer = fn; }
    get onerror() { return this._onerror; }
    set onerror(fn) { this._onerror = fn; }
    get ontrace() { return this._ontrace; }
    set ontrace(fn) { this._ontrace = fn; }
    addEventListener(type, listener, useCapture) { }
    removeEventListener(type, listener, useCapture) { }
    async sendAnswer(rtcSessionDescription) { }
    async sendCandidate(rtcIceCandidate) { }
    async sendOffer(rtcSessionDescription) { }
}

class WhepSignalingChannel extends SignalingChannel {
    /**
     * 
     * @param {*} url /stream/whep
     */
    constructor(url, timeout = 30000) {
        super();
        this.url = url;
        this.httpTimeoutId = undefined;
        this.timeout = timeout;
        this.eTag = '';
        this.offerData = null; // Initialize offerData
    }

    generateSdpFragment(offerData, candidates) {
        if (!candidates || !candidates.sdpMLineIndex) return '';

        const candidatesByMedia = {};
        for (const candidate of candidates) {

            const mid = candidate.sdpMLineIndex;
            if (candidatesByMedia[mid] === undefined) {
                candidatesByMedia[mid] = [];
            }
            candidatesByMedia[mid].push(candidate);
        }

        let frag = 'a=ice-ufrag:' + offerData.iceUfrag + '\r\n'
            + 'a=ice-pwd:' + offerData.icePwd + '\r\n';

        let mid = 0;

        for (const media of offerData.medias) {
            if (candidatesByMedia[mid] !== undefined) {
                frag += 'm=' + media + '\r\n'
                    + 'a=mid:' + mid + '\r\n';

                for (const candidate of candidatesByMedia[mid]) {
                    frag += 'a=' + candidate.candidate + '\r\n';
                }
            }
            mid++;
        }

        return frag;
    }

    parseOffer(offer) {
        const ret = {
            iceUfrag: '',
            icePwd: '',
            medias: [],
        };

        for (const line of offer.split('\r\n')) {
            if (line.startsWith('m=')) {
                ret.medias.push(line.slice('m='.length));
            } else if (ret.iceUfrag === '' && line.startsWith('a=ice-ufrag:')) {
                ret.iceUfrag = line.slice('a=ice-ufrag:'.length);
            } else if (ret.icePwd === '' && line.startsWith('a=ice-pwd:')) {
                ret.icePwd = line.slice('a=ice-pwd:'.length);
            }
        }

        return ret;
    }

    get isOpen() {
        return true;
    }

    close() {
        if (this.httpTimeoutId) {
            clearTimeout(this.httpTimeoutId);
            this.httpTimeoutId = undefined;
        }
        if (this.controller)
            this.controller.abort();
    }

    async sendCandidate(candidates) { // Properly handle sendCandidate with offerData

        if (!this.offerData) {
            if (this.onerror)
                this.onerror(new Error('Offer data not set before sending candidates.'));
            return;
        }

        const sdpFrag = this.generateSdpFragment(this.offerData, [candidates]);
        if (!sdpFrag) return;

        try {
            const response = await fetch(this.url, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/trickle-ice-sdpfrag',
                    'If-Match': this.eTag,
                },
                body: sdpFrag,
            });

            if (response.status !== 204) { // Error handling for bad status codes
                // Throw error to be caught in catch block
                throw new Error(`sendCandidate bad status code ${response.status}`);
            }
        }
        catch (err) {
            if (this.onerror)
                this.onerror(err);
        }
    }

    async sendOffer(desc) { // Properly handle sendOffer and initialize offerData

        this.close();

        this.offerData = this.parseOffer(desc.sdp); // Initialize offerData

        this.controller = new AbortController();
        this.httpTimeoutId = setTimeout(() => this.controller.abort(), this.timeout);

        try {

            const response = await fetch(this.url, {  
                signal: this.controller.signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/sdp',
                },
                body: desc.sdp,
            });

            if (response) {
                clearTimeout(this.httpTimeoutId);

                if (response.status !== 201) {
                    throw new Error(`sendOffer bad status code ${response.status}`);
                }

                this.eTag = response.headers.get('E-Tag');

                if (this.onanswer) {
                    const sdp = await response.text();
                    this.onanswer({
                        type: 'answer',
                        sdp: decodeURIComponent(sdp)
                    });
                }
            }
            else {
                throw new Error(`Error connecting to whep signaling server`);
            }
        }
        catch (err) {
            let message;
            switch (err.name) {
                case "AbortError":
                    if (this.onerror)
                        this.onerror({ message: `whep signaling server timeout` });
                    break;
                default:
                    if (this.onerror)
                        this.onerror(err);
            }
        }
        finally {
            clearTimeout(this.httpTimeoutId);
            this.httpTimeoutId = undefined;
        }
    }
}

class Go2RtcSignalingChannel extends SignalingChannel {
    constructor(url) {
        super();
        this.ws = null;
        this.url = url;
        this.websocketTimeoutId = undefined;

        // Bind event handler methods to maintain 'this' context
        this.handleMessage = this.handleMessage.bind(this);
        this.handleOpen = this.handleOpen.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handleClose = this.handleClose.bind(this);
    }

    /**
     * Checks if the WebSocket connection is open.
     */
    get isOpen() {
        return this.ws != null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Opens a WebSocket connection with a specified timeout.
     * @param {number} timeout - The time in milliseconds to wait before timing out.
     * @returns {Promise<void>} - Resolves when the connection is successfully opened.
     */
    async open(timeout) {
        return new Promise((resolve, reject) => {
            if (this.ws) {
                reject(new Error("WebSocket is already open."));
                return;
            }

            const ws = new WebSocket(this.url);
            ws.binaryType = "arraybuffer";

            // Add event listeners
            ws.addEventListener('message', this.handleMessage);
            ws.addEventListener('open', this.handleOpen);
            ws.addEventListener('error', this.handleError);
            ws.addEventListener('close', this.handleClose);

            // Assign the WebSocket instance
            this.ws = ws;

            // Set up timeout handling
            this.websocketTimeoutId = setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CLOSING) {
                    ws.close();
                    if (this.onerror) {
                        this.onerror(new Error(`WebSocket connection timed out after ${timeout}ms`));
                    }
                    reject(new Error(`WebSocket connection timed out after ${timeout}ms`));
                }
            }, timeout);

            // Store resolve and reject to use in handlers
            this._resolveOpen = resolve;
            this._rejectOpen = reject;
        });
    }

    /**
     * Closes the WebSocket connection and cleans up event listeners.
     */
    close() {
        const ws = this.ws;
        if (ws) {

            // Clear any pending timeout
            if (this.websocketTimeoutId) {
                clearTimeout(this.websocketTimeoutId);
                this.websocketTimeoutId = undefined;
            }

            this.trace(`Closing websocket in ${ws.readyState} state`);
            
            // Close the WebSocket if it's still open or connecting
            if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(ws.readyState)) {
                ws.close();
            }

            // Remove all event listeners
            ws.removeEventListener('message', this.handleMessage);
            ws.removeEventListener('open', this.handleOpen);
            ws.removeEventListener('error', this.handleError);
            ws.removeEventListener('close', this.handleClose);
            
            // Nullify the WebSocket reference
            this.ws = null;
        }
    }

    /**
     * Sends a WebRTC ICE candidate through the WebSocket.
     * @param {RTCIceCandidate|null} rtcIceCandidate - The ICE candidate to send.
     */
    async sendCandidate(rtcIceCandidate) {
        if (!this.isOpen) throw new Error(`Cannot send candidate from closed WebSocket`);

        const message = {
            type: "webrtc/candidate",
            value: rtcIceCandidate ? rtcIceCandidate.candidate : ""
        };

        this.ws.send(JSON.stringify(message));
    }

    /**
     * Sends a WebRTC offer through the WebSocket.
     * @param {RTCSessionDescription} rtcSessionDescription - The session description to send.
     */
    async sendOffer(rtcSessionDescription) {
        if (!this.isOpen) throw new Error(`Cannot send offer from closed WebSocket`);

        const message = {
            type: 'webrtc/offer',
            value: rtcSessionDescription.sdp
        };

        this.ws.send(JSON.stringify(message));
    }

    /**
     * Handles incoming WebSocket messages.
     * @param {MessageEvent} ev - The message event.
     */
    handleMessage(ev) {
        if (typeof ev.data === "string") {
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (error) {
                console.error("Failed to parse message:", ev.data);
                return;
            }

            switch (msg.type) {
                case "webrtc/candidate":
                    if (this.oncandidate) {
                        const candidate = msg.value ? { candidate: msg.value, sdpMid: "0" } : undefined;
                        this.oncandidate(candidate);
                    }
                    break;
                case "webrtc/answer":
                    if (this.onanswer) {
                        this.onanswer({ type: "answer", sdp: msg.value });
                    }
                    break;
                case "error":
                    if (msg.value && this.onerror) {
                        this.onerror({ message: msg.value });
                    }
                    this.close();
                    break;
                default:
                    // Handle other message types if necessary
                    break;
            }
        } else {
            // Handle binary data if needed
            console.warn("Received binary data which is not handled:", ev.data);
        }
    }

    /**
     * Handles the WebSocket open event.
     */
    handleOpen() {
        // Clear the connection timeout
        if (this.websocketTimeoutId) {
            clearTimeout(this.websocketTimeoutId);
            this.websocketTimeoutId = undefined;
        }

        // Resolve the open promise
        if (this._resolveOpen) {
            this._resolveOpen();
            this._resolveOpen = null;
            this._rejectOpen = null;
        }

        this.trace(`WebSocket signaling channel opened`);
    }

    /**
     * Handles the WebSocket error event.
     */
    handleError() {
        // Clear the connection timeout
        if (this.websocketTimeoutId) {
            clearTimeout(this.websocketTimeoutId);
            this.websocketTimeoutId = undefined;
        }

        // Reject the open promise if it's pending
        if (this._rejectOpen) {
            this._rejectOpen(new Error("WebSocket encountered an error"));
            this._resolveOpen = null;
            this._rejectOpen = null;
        }

        // Notify via onerror callback
        if (this.onerror) {
            this.onerror(new Error("WebSocket encountered an error"));
        }

        // Close the WebSocket to trigger cleanup
        this.close();
    }

    /**
     * Handles the WebSocket close event.
     */
    handleClose() {
        
        this.trace(`WebSocket signaling channel closed`);

        // Nullify the WebSocket reference
        this.ws = null;

        // Reject the open promise if it's pending
        if (this._rejectOpen) {
            this._rejectOpen(new Error("WebSocket connection was closed before opening"));
            this._resolveOpen = null;
            this._rejectOpen = null;
        }
    }

    trace(message)
    {
        if (this.ontrace)
            this.ontrace(message);
    }
}

class RTSPtoWebSignalingChannel extends SignalingChannel {
    /**
     * 
     * @param {*} url /stream/{STREAM_ID}/channel/{CHANNEL_ID}/webrtc
     */
    constructor(url, timeout = 30000) {
        super();
        this.url = url;
        this.httpTimeoutId = undefined;
        this.timeout = timeout;
    }

    get isOpen() {
        return true;
    }

    close() {
        if (this.httpTimeoutId) {
            clearTimeout(this.httpTimeoutId);
            this.httpTimeoutId = undefined;
        }
        if (this.controller)
            this.controller.abort();
    }

    async sendOffer(rtcSessionDescription) {

        this.close();

        this.controller = new AbortController();
        this.httpTimeoutId = setTimeout(() => this.controller.abort(), this.timeout);

        try {

            const data = "data=" + encodeURIComponent(rtcSessionDescription.sdp); // Use encodeURIComponent for safety
            const response = await fetch(this.url, {
                signal: this.controller.signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: data
            });

            if (response) {
                clearTimeout(this.httpTimeoutId);

                const decoder = new TextDecoder("utf-8");
                const reader = response.body.getReader();
                let result = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    result += decoder.decode(value, { stream: true });
                }
                const stringValue = decoder.decode(result);

                if (response.ok) {
                    if (this.onanswer) {
                        this.onanswer(
                            { type: "answer", sdp: decodeURIComponent(stringValue) }
                        );
                    }
                }
                else {
                    throw new Error(stringValue);
                }
            }
            else {
                throw new Error(`Error connecting to signaling server`);
            }
        }
        catch (err) {
            switch (err.name) {
                case "AbortError":
                    if (this.onerror)
                        this.onerror({ message: `Signaling server timeout` });
                    break;
                default:
                    if (this.onerror)
                        this.onerror(err);
            }
        }
        finally {
            clearTimeout(this.httpTimeoutId);
            this.httpTimeoutId = undefined;
        }
    }
}
