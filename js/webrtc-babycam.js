
console.info(
    `%c  WebRTC Babycam \n%c`,
    'color: orange; font-weight: bold; background: black',
    'color: white; font-weight: bold; background: dimgray',
);

const noop = () => {};

/**
 * WebRTC Babycam Custom Element
 * Provides a lag-free 2-way audio, video, and image camera card.
 */
class WebRTCsession {
    static sessions = new Map();
    static unmuteEnabled = undefined;

    static globalDebug = (new URLSearchParams(window.location.search)).has('debug');
    static globalStats = (new URLSearchParams(window.location.search)).has('stats');

    // Timeout configurations in milliseconds
    static TIMEOUT_SIGNALING = 10000;
    static TIMEOUT_ICE = 10000;
    static TIMEOUT_RENDERING = 10000;
    static TIMEOUT_ERROR = 30000;
    static TIMEOUT_IMAGE = 10000;
    static IMAGE_INTERVAL = 3000;
    static TERMINATION_DELAY = WebRTCsession.IMAGE_INTERVAL;

    constructor(key, hass, config) {
        if (!config || !config.entity) {
            throw new Error("Entity configuration is required but entity needn't exist");
        }

        this.key = key;
        this.hass = hass;
        this.config = config;

        this.state = {
            cards: new Set(),
            activeCard: null,
            call: null,
            image: null,
            reconnectDate: 0,
            statistics: "",
            status: 'uninitialized' 
            
        };

        this.lastError = null;
        this.eventTarget = new EventTarget();
        this.fetchImageTimeoutId = undefined;
        this.imageLoopTimeoutId = undefined;
        this.watchdogTimeoutId = undefined;
        this.terminationTimeoutId = undefined;

        this.trace = noop;
        this.resetStats();

        if (this.config.background === true && this.background === false)
            this.background = true;

        if (this.config.microphone === true && this.microphone === false)
            this.microphone = true;

        this.determineUnmuteEnabled();
    }

    static key(config) {
        let key = config.entity.replace(/[^a-z0-9A-Z_-]/g, '-');

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

    async determineUnmuteEnabled() {
        if (WebRTCsession.unmuteEnabled !== undefined) {
            return WebRTCsession.unmuteEnabled;
        }
        WebRTCsession.unmuteEnabled = await WebRTCsession.canPlayUnmutedAudio();
        this.trace(`Unmute ${WebRTCsession.unmuteEnabled ? 'enabled' : 'disabled'}`);
        return WebRTCsession.unmuteEnabled;
    }

    static async canPlayUnmutedAudio() {
        return new Promise((resolve) => {
            // 1-second silent mp3
            const silentAudioDataURI = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZy1wb3J0aWZ5AAAAAG1pZjFzdWRvAAAAAG1pZjF2bXJ0AAAAAAAAAAAPQ29yZmUAAAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA==';

            const audio = new Audio();
            audio.src = silentAudioDataURI;
            audio.muted = false;

            const onPlay = () => {
                cleanup();
                resolve(true);
            };

            const onError = () => {
                cleanup();
                resolve(false);
            };

            const cleanup = () => {
                audio.removeEventListener('play', onPlay);
                audio.removeEventListener('error', onError);
                audio.pause();
                audio.src = '';
            };

            audio.addEventListener('play', onPlay);
            audio.addEventListener('error', onError);

            audio.play().catch(() => {
                cleanup();
                resolve(false);
            });
        });
    }

    /**
     * Formats bytes into a human-readable string.
     * @param {number} a - Number of bytes.
     * @param {number} [b=2] - Number of decimal places.
     * @returns {string} Formatted byte string.
     */
    formatBytes(a, b = 2) {
        if (!+a) return "0 Bytes";
        const c = 0 > b ? 0 : b,
            d = Math.floor(Math.log(a) / Math.log(1024));
        return `${parseFloat((a / Math.pow(1024, d)).toFixed(c))} ${["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"][d]}`;
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

    /**
     * Calculates the mode (most frequent element) of an array.
     * @param {Array} a - Array of elements.
     * @returns {*} The mode of the array.
     */
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
                else if (report.type === "inbound-rtp" && report.kind === 'video') {
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

    async updateStatistics() {

        try
        {
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
                        this.statsHistory = [current];
                        return;
                    }

                    if (frameDecodeRate >= 0.995) frameDecodeRate = 1;
                    header += `<br>render quality: ${(frameDecodeRate * 100).toFixed(1)}%`;
                }
            }
        
            this.state.statistics = header;
        }
        catch (err) {
            this.trace(err);
        }
    }

    get isAnyCardPlaying() {
        if (!this.isStreaming)
            return false;

        const hasCardPlaying = [...this.state.cards].some(card => card.isPlaying === true);
        return hasCardPlaying;
    }

    get isAnyCardVisible() {
        const hasCardVisible = [...this.state.cards].some(card => card.isVisibleInViewport === true);
        return hasCardVisible;
    }
 

     /**
     * Retrieves the smallest 'interval' value from all attached cards.
     * If no intervals are defined, returns undefined.
     * @returns {number} The minimum interval or default if none are set.
     */
     getMinCardInterval() {
        const intervals = Array.from(this.state.cards)
            .map(card => card.config?.interval)
            .filter(interval => typeof interval === 'number');

        if (intervals.length === 0) {
            return WebRTCsession.IMAGE_INTERVAL;
        }

        const interval = Math.min(...intervals);
        return interval;
    }
    
    imageLoop() {
        if (this.imageLoopTimeoutId) {
            return;
        }
        else if (this.isTerminated) {
            this.imageLoopTimeoutId = undefined;
            return;
        }

        const interval = this.getMinCardInterval();
        if (interval == 0) return;

        this.imageLoopTimeoutId = setTimeout(() => {
            this.imageLoopTimeoutId = undefined;
            this.imageLoop();
        }, interval);

        if (this.isAnyCardPlaying) return;
        this.fetchImage();
    }

    async play(id = undefined) {
        if (id != this.watchdogTimeoutId) {
            return;
        }

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
            else if (this.state.reconnectDate === 0) {

                // initialize connection
                await this.endCall(this.state.call);
                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);
                this.startCall();
            }
            else if (now < this.state.reconnectDate) {
                // Connecting or previously connected, extend reconnection if streaming:
                
                if (this.isStreaming && (this.config.video === false || this.isAnyCardPlaying)) {

                    // todo: better detect interrupted audio

                    this.extendConnectionTimeout(WebRTCsession.TIMEOUT_RENDERING);
                    this.eventTarget.dispatchEvent(new CustomEvent('heartbeat', { detail: {} }));
                    // todo: if (this.config.stats)
                    await this.getStats(this.state.call);
                }
            }
            else {
                // We haven't connected; restart call
                if (this.state.call) {
                    this.state.reconnectDate = 0
                    this.trace(`Play watchdog timeout`);
                }
            }

            // todo: if (this.config.stats)
            await this.updateStatistics();
            
        }
        catch (err) {
            this.lastError = err.message;
            this.trace(`Play ${err.name}: ${err.message}`);
        }
        finally {
            
            const now = Date.now(); 
            const interval = 1000 - (now % 1000);  
            const connectionTimeout = this.state.reconnectDate - now;
            const delay = Math.max(10, Math.min(connectionTimeout, interval));

            clearTimeout(this.watchdogTimeoutId);
            const loop = setTimeout(() => this.play(loop), delay);
            this.watchdogTimeoutId = loop;
        }
    }

    set tracing(enabled) {
        if (enabled)
            this.trace = this._trace.bind(this);
        else
            this.trace = noop;
    }

    get tracing() {
        return this.trace !== noop;
    }

    _trace(message, o) {
        const call = this.state?.call;
        const callStarted = call?.startDate;
        const now = Date.now();
        
        const timestamp = callStarted ? (now - callStarted) : (new Date).getTime();
        const id = call?.id ?? this.key;
        const text = `${id}:${timestamp}: ${message}`;
        if (o)
            console.debug(text, o);
        else
            console.debug(text);

        this.eventTarget.dispatchEvent(new CustomEvent('trace', { detail: { message: text } }));
    }

    extendConnectionTimeout(ms = 0) {
        this.state.reconnectDate = Math.max(Date.now() + ms, this.state.reconnectDate);
    }


    async restart(call) {
        this.trace('Restarting call');
        await this.endCall(call);

        clearTimeout(this.watchdogTimeoutId);
        this.watchdogTimeoutId = undefined;
        this.state.reconnectDate = 0;
        this.play();
    }


    attachCard(card, messageHandler) {

        this.trace(`Attaching new card ${card.instanceId} to session`);
        if (this.terminationTimeoutId) {
            clearTimeout(this.terminationTimeoutId);
            this.terminationTimeoutId = null;
            this.trace("Scheduled termination aborted due to session attachment");
        }

        if (this.state.cards.has(card)) return;

        this.state.cards.add(card);

        const sessionEventTypes = [
            'statuschange',
            'remotestream',
            'backgroundchange',
            'heartbeat',
            'microphonechange',
            'imagechange',
            'trace',
            'debug',
            'mute',
            'unmuteEnabled',
            'connected',
        ];
        
        sessionEventTypes.forEach(type => {
            this.eventTarget.addEventListener(type, messageHandler);
        });

        this.tracing = this.tracing || card.config.debug || WebRTCsession.globalDebug;

        if (this.config.audio === false && this.config.video === false) {
            setTimeout(() => {
                this.play();
            });
            return;
        }
        
        //todo: WebRTCsession.enablePinchZoom();

        if (card.isVisibleInViewport || this.background) {
            setTimeout(() => {
                this.play();
            });
        } else {
            this.trace("attachCard: card is not visible & background=false => not playing");
        }
    }

    detachCard(card, messageHandler) {
        if (!this.state.cards.has(card)) {
            this.trace("detachCard: Card mismatch or already detached; skipping");
            return;
        }

        if (this.background) {
            this.trace("detachCard: Session sent to background");
            return;
        }

        const sessionEventTypes = [
            'statuschange',
            'remotestream',
            'backgroundchange',
            'heartbeat',
            'microphonechange',
            'imagechange',
            'trace',
            'debug',
            'mute',
            'unmuteEnabled',
            'connected',
        ];
        
        sessionEventTypes.forEach(type => {
            this.eventTarget.removeEventListener(type, messageHandler);
        });

        this.state.cards.delete(card);
        const remaining = this.state.cards.size;
        if (remaining > 0) {
            this.trace(`Detached ${remaining} cards remaining in this session`);
            return;
        }

        this.terminationTimeoutId = setTimeout(() => {
            if (this.state.cards.size > 0) {
                this.trace("Reattachment detected; aborting session terminate");
                this.terminationTimeoutId = undefined;
            } else {
                this.trace("Terminating session");
                this.terminate();
            }
        }, WebRTCsession.TERMINATION_DELAY);
        this.trace("Termination scheduled");
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
            session.eventTarget.dispatchEvent(new CustomEvent('unmuteEnabled', { detail: { unmuteEnabled: true } }));
        }
    }
        
    static toggleGlobalMute() {
        WebRTCsession.globalMute = !WebRTCsession.globalMute;
        console.debug(`Global mute ${WebRTCsession.globalMute ? 'enabled' : 'disabled'}`);
        
        const iterator = WebRTCsession.sessions.values();
        for (const session of iterator) {
            session.eventTarget.dispatchEvent(new CustomEvent('mute', { detail: { mute: WebRTCsession.globalMute } }));
        }
    }

    static toggleGlobalDebug() {
        WebRTCsession.globalDebug = !WebRTCsession.globalDebug;
        console.debug(`Global debug mode ${WebRTCsession.globalDebug ? 'enabled' : 'disabled'}`);
        
        const iterator = WebRTCsession.sessions.values();
        for (const session of iterator) {
            session.tracing =  WebRTCsession.globalDebug;
            session.eventTarget.dispatchEvent(new CustomEvent('debug', { detail: { debug: WebRTCsession.globalDebug } }));
        }
    }
    
    static toggleGlobalStats() {
        WebRTCsession.globalStats = !WebRTCsession.globalStats;
        console.debug(`Global stats mode ${WebRTCsession.globalStats ? 'enabled' : 'disabled'}`); 
    }

    // static enablePinchZoom() {
    //     let viewport = document.querySelector("meta[name=viewport]");
    //     if (!viewport) {
    //         viewport = document.createElement("meta");
    //         viewport.setAttribute("name", "viewport");
    //         viewport.setAttribute("content", "width=device-width, viewport-fit=cover");
    //         document.head.appendChild(viewport);
    //     }

    //     if (!WebRTCsession.defaultViewportContent) {
    //         const mediaQueryList = window.matchMedia("(orientation: portrait)");
    //         mediaQueryList.addEventListener('change', () => WebRTCsession.resetPinchZoomScale());
    //         WebRTCsession.defaultViewportContent = viewport.getAttribute('content');
    //     }

    //     WebRTCsession.resetPinchZoomScale();
    //     viewport.setAttribute('content', "initial-scale=1.0, minimum-scale=1.0, maximum-scale=5.0");
    // }

    // static resetPinchZoomScale() {
    //     const viewport = document.querySelector("meta[name=viewport]");
    //     if (!viewport) return;
    //     const content = viewport.getAttribute('content');
    //     viewport.setAttribute('content', "initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0");
    //     viewport.setAttribute('content', content);
    // }

    // static restorePinchZoomDefaults() {
    //     WebRTCsession.resetPinchZoomScale();
    //     const viewport = document.querySelector("meta[name=viewport]");
    //     if (viewport && WebRTCsession.defaultViewportContent) {
    //         viewport.setAttribute("content", WebRTCsession.defaultViewportContent);
    //     }
    // }

    get status() {
        return this.state.status;
    }

    setStatus(value) {
        if (this.state.status === value) return;
        this.state.status = value;
        this.trace(`STATE ${value}`);
        this.eventTarget.dispatchEvent(new CustomEvent('statuschange', { detail: { status: value } }));
    }

    terminate() {
        this.setStatus('terminated');
        
        clearTimeout(this.watchdogTimeoutId);
        clearTimeout(this.imageLoopTimeoutId);
        clearTimeout(this.fetchImageTimeoutId);
        clearTimeout(this.terminationTimeoutId);
        
        this.watchdogTimeoutId = undefined;
        this.imageLoopTimeoutId = undefined;
        this.fetchImageTimeoutId = undefined;
        this.terminationTimeoutId = undefined;

        this.state.reconnectDate = 0;

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
        // todo: toggle microphone currently causes session key change and requires call to be restarted
        localStorage.setItem(`webrtc.${this.key}.microphone`, value);
        if (this.isStreaming)
            this.restart(this.state.call);
        this.eventTarget.dispatchEvent(new CustomEvent('microphonechange', { detail: { microphone: value } }));
    }

    get isTerminated() {
        return this.state.status == 'terminated';
    }

    get isStreaming() {
        const pc = this.state.call?.peerConnection;
        if (!pc) return false;
    
        const iceState = pc.iceConnectionState;
        if (!(iceState === "connected" || iceState === "completed")) return false;
    
        const remoteStream = this.state.call?.remoteStream;
        if (!remoteStream) return false;
    
        const hasActiveTracks = remoteStream.getTracks().some(track => track.readyState === 'live');
        return hasActiveTracks;
    }

    get isStreamingAudio() {
        const remoteStream = this.state.call?.remoteStream;
        if (!remoteStream) return false;
    
        const audioTracks = remoteStream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) return false;
    
        return audioTracks.some(track => track.readyState === 'live');
    }

    async endCall(call) {

        if (!call) return;

        // attempt to refresh image before tear down 
        try {
            await this.fetchImage();
        } catch { }
         
        const sc = call.signalingChannel;
        const pc = call.peerConnection;
        const localStream = call.localStream;
        const remoteStream = call.remoteStream;

        this.trace('Ending call');
        if (sc) {
            try {
                sc.close();
            } catch { this.trace('Error closing signaling channel'); }
        }

        if (pc) {
            try {
                pc.close();
            } catch { }
        }

        if (localStream) {
            localStream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch { }
            });
        }

        if (remoteStream) {
            remoteStream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch { }
            });
        }
        
        call.signalingChannel = null;
        call.peerConnection = null;
        call.remoteStream = null;
        call.localStream = null;

        this.setStatus('disconnected');
        this.state.call = null;
        this.trace('Call ended');

        this.eventTarget.dispatchEvent(new CustomEvent('connected', { detail: {connected: false} }));        
    }

    createCallId(startDate) {
        const seconds = Math.floor((startDate / 1000) % 60);
        const minutes = Math.floor((startDate / 60000) % 60);
        const result = `${minutes.toString().padStart(2, '0')}${seconds.toString().padStart(2, '0')}`;
        return this.key + '_' + result;
    }

    traceCall(call, message) {
        this.trace(`${call?.id}: ${message}`);
    }

    async startCall() {
        if (this.config.video === false && this.config.audio === false) {
            this.trace('WebRTC disabled');
            return;
        }

        const now = Date.now();
        const call = {
            id: this.createCallId(now),
            startDate: now,
            signalingChannel: null,
            peerConnection: null,
            localStream: null,
            remoteStream: null
        };

        if (this.state.call) {
            this.trace(`Terminating existing call ${this.state.call.id} before starting new call.`);
            this.endCall(this.state.call);
        }

        this.state.call = call;

        this.trace(`Call started`);
        this.setStatus('connecting');
        this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);

        if (this.microphone) {
            // Acquire microphone for two-way audio
            if (window.isSecureContext && navigator.mediaDevices) {
                try {
                    call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                }
                catch (err) {
                    this.trace(`Failed to open microphone: ${err.name}:${err.message}`);
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

        this.trace("Added transceivers");

        let offer;
        try {
            offer = await call.peerConnection.createOffer();
        }
        catch (err) {
            this.lastError = `Failed to create WebRTC offer. ${err.name}: ${err.message}`;
            this.trace(this.lastError);
            this.setStatus('error');
            this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ERROR);
            setTimeout(() => this.endCall(call), 0);
            return;
        }
        await call.peerConnection.setLocalDescription(offer);

        if (call.signalingChannel) {
            this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);
            call.signalingChannel.sendOffer(offer);
            this.trace('Sent offer');
        }
        else {
            this.trace('Cannot send offer. Signaling channel invalid');
        }
    }

    createPeerConnection(call) {
        if (call.peerConnection) {
            this.trace("Existing peer connection detected. Closing first.");
            try { call.peerConnection.close(); } catch { }
            call.peerConnection = null;
        }

        const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
        const pc = new RTCPeerConnection(config);

        pc.oniceconnectionstatechange = () => {
            this.trace(`ICE state: ${pc.iceConnectionState}`);

            const state = pc.iceConnectionState;
            switch (state) {
                case "completed":
                case "connected":
                    this.setStatus('connected');
                    this.eventTarget.dispatchEvent(new CustomEvent('connected', { detail: {connected: true} }));
                    this.extendConnectionTimeout(WebRTCsession.TIMEOUT_RENDERING);
                    break;

                case "failed":
                case "closed":
                case "disconnected":
                    this.restart(call);
                    break;
            }
        };

        pc.onicecandidate = ev => {
            if (!call.signalingChannel?.isOpen) {
                this.trace(`Signaling channel closed, cannot send ICE '${ev?.candidate?.candidate}'`);
                return;
            }
            if (ev.candidate) {
                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_SIGNALING);
                call.signalingChannel.sendCandidate(ev.candidate);
                this.trace(`Sent ICE candidate '${ev.candidate.candidate}'`);
            } else {
                call.signalingChannel.sendCandidate();
                this.trace('Completed gathering ICE candidates');
            }
        };

        pc.ontrack = ev => {
            this.trace('Received track');
            if (!call.remoteStream) {
                call.remoteStream = new MediaStream();
                this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: call.remoteStream } }));
            }
            call.remoteStream.addTrack(ev.track);
        };

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
            // custom-component proxy
            url = '/api/webrtc/ws?';
            if (this.config.url)
                url += '&url=' + encodeURIComponent(this.config.url);
            if (this.config.entity)
                url += '&entity=' + encodeURIComponent(this.config.entity);
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
                if (this.config.url)
                    url += '&url=' + encodeURIComponent(this.config.url);
                if (this.config.entity)
                    url += '&entity=' + encodeURIComponent(this.config.entity);
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
            this.trace(this.lastError);
            this.setStatus('error');
            return;
        }

        try {
            signalingChannel.oncandidate = (candidate) => {
                if (candidate) {
                    this.trace(`Received ICE candidate '${candidate.candidate}'`);
                } else {
                    this.trace('Received end of ICE candidates');
                }
                try {
                    if (candidate)
                        call.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
                catch (err) {
                    this.trace(`addIceCandidate error: ${err.name}:${err.message}`);
                }
            };

            signalingChannel.onanswer = async (answer) => {
                this.trace("Received answer");
                try {
                    await call.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                    this.trace(`Remote description set`);
                } catch (err) {
                    this.lastError = err.message;
                    this.trace(this.lastError);
                    this.setStatus('error');
                    this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ERROR);
                }
            };

            signalingChannel.onerror = (err) => {
                this.trace(`Signaling error: ${err.message}`);
                this.lastError = err.message;
                this.trace(this.lastError);
                this.setStatus('error');
                this.extendConnectionTimeout(WebRTCsession.TIMEOUT_ERROR);
            };

            signalingChannel.ontrace = (message) => {
                this.trace(`${message}`);
            };

            await signalingChannel.open(WebRTCsession.TIMEOUT_SIGNALING);
            if (signalingChannel.isOpen) {
                this.trace(`Opened '${url}'`);
            }
            else {
                call.signalingChannel = null;
                this.lastError = `Failed to open signaling channel`;
                this.trace(this.lastError);
                this.setStatus('error');
            }

        } catch (err) {
            this.lastError = `Signaling channel error: ${err.message}`;
            this.trace(this.lastError);
            this.setStatus('error');
        }
    }

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

                const response = await fetch(url, {
                    signal: abort.signal,
                    cache: "no-store"
                });

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
                };
                accept(thumbnail);
            };
            image.onerror = () => {
                reject(new Error('Failed to load image for thumbnail'));
            };
            image.src = URL.createObjectURL(blob);
        });
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////
/////////////////////////////////

/**
 * WebRTCbabycam Custom Element
 */
class WebRTCbabycam extends HTMLElement {

    static instanceCount = 0

    constructor() {
        super();

        WebRTCbabycam.instanceCount += 1;
        this.instanceId = WebRTCbabycam.instanceCount;

        this.waitStartDate = null;
        this.isVisibleInViewport = false;
        this.observersActive = false;
        
        this.resizeObserver = null;
        this.visibilityObserver = null;
        this.updateVisibility = noop;

        this._cardConfig = null;
        this._cardMedia = null;
        this._session = null;

        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        this.handleWindowFocus = this.handleWindowFocus.bind(this);
        this.handleDocumentVisibility = this.handleDocumentVisibility.bind(this);
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleSessionEvent = this.handleSessionEvent.bind(this); 
        this.handleMediaEvent = this.handleMediaEvent.bind(this); 
    }

    get config() {
        return this._cardConfig;
    }

    get media() {
        return this._cardMedia;
    }

    get session() {
        return this._session;
    }

    get header() {
        const header = this.shadowRoot.querySelector('.header');
        return header ? header.innerHTML : '';
    }
    set header(text) {
        const header = this.shadowRoot.querySelector('.header');
        if (header) {
            header.innerHTML = text;
            header.style.display = text ? 'block' : 'none';
        }
    }

    setDebugVisibility(show) {
        const log = this.shadowRoot.querySelector('.log');
        if (!log) return;

        if (show) {            
            log.classList.remove('hidden');

            if (this.session && this.session.tracing !== true)
                this.session.tracing = true;
        }
        else {
            log.classList.add('hidden');
        }
    }

    async setControlsVisibility(show) {
        const timeout = 3000;
        const media = this.media;
        if (!media) return;

        const showActive = () => {
            return Date.now() < Number(media?.getAttribute('show')) + timeout
                || (media?.tagName == 'VIDEO' && media?.getAttribute('playing') === 'paused');
        };

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
        if (!ptz) return;

        const timer = ptz.getAttribute('show');
        if (timer) {
            clearTimeout(Number(timer));
            ptz.removeAttribute('show');
        }

        if (show) {
            ptz.setAttribute('show',
                setTimeout(() => { this.setPTZVisibility(false); }, timeout));
        }
    }

    renderCard(video, muted, background) {
        this.shadowRoot.innerHTML = `
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
            video[playing="audiovideo"], video[playing="video"] {
                visibility: visible;
                z-index: 2;
            }
            .image:not([size]) ~ video {
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
                line-height: 1.1;
                font-size: clamp(9px, 0.5vw, 12px);
                font-family: 'Roboto Condensed', Arial, sans-serif;
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

        
        //this._cardMedia = this.createMedia(this.config.video, this.config.muted, this.session.background)();
        const container = this.shadowRoot.querySelector('.media-container');

        this._cardMedia = this.createMedia(video, muted, background);
        container.insertBefore(this._cardMedia, container.querySelector('.state'));
    }

    renderPTZ(hasMove, hasZoom, hasHome, hasVol, hasMic) {

        const ptzHeight = 10 + (hasMove ? 80 : 0) + 10 + (hasZoom ? 40 : 0) + 10 + (hasHome ? 40 : 0) + 10 + (hasVol ? 80 : 0) + 10 + (hasMic ? 80 : 0) + 10;
        const ptzMaxHeight = 100 + (4 * 80) + 100;

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
                .ptz[show] {
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

    renderShortcuts(services) {
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

        const icons = services.map((value, index) =>
            `<ha-icon data-index="${index}" icon="${value.icon}" title="${value.name}"></ha-icon>`
        ).join("");

        card.insertAdjacentHTML('beforeend', `
        <div class="shortcuts">${icons}</div>
        `);
    }

    renderStyle(userCardStyle) {
        if (!userCardStyle) return;
        const style = document.createElement('style');
        style.innerText = userCardStyle;
        const card = this.shadowRoot.querySelector('.card');
        card.insertAdjacentElement('beforebegin', style);
    }

    syncLoadingAnimation() {
        const now = performance.now();

        // Select all elements with the `icon="mdi:loading"` attribute
        const loadingElements = document.querySelectorAll('.state[icon="mdi:loading"]');
    
        // Synchronize animations
        loadingElements.forEach(el => {
          const delay = -(now % 1000) / 1000; // Calculate delay relative to the current time
          el.style.animationDelay = `${delay}s`; // Apply the negative delay
        });
      }

    static globalInit() {
        if (WebRTCbabycam.initialStaticSetupComplete)
            return;

        const handleKeyUp = (ev) => {
            //WebRTCsession.enableUnmute();
            const unmute = "KeyT";
            const debug = "KeyD";
            const shiftA = "ShiftRight";
            const shiftB = "ShiftLeft";
            const shiftC = "ShiftKey";
                switch (ev.code) {
                    case unmute:
                        WebRTCsession.toggleGlobalMute();
                        break;
                    case debug:
                        WebRTCsession.toggleGlobalDebug();
                        break;
                    case shiftA:
                    case shiftB:
                    case shiftC:
                        // if (session.state.activeCard?.config?.debug) {
                        //     const log = session.state.activeCard.shadowRoot.querySelector('.log');
                        //     if (log) log.classList.remove('pointerevents');
                        // }
                        break;
                }
        };

        document.addEventListener('mousedown', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        document.addEventListener('keydown', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        document.addEventListener('keyup', handleKeyUp, true);
        
        WebRTCbabycam.initialStaticSetupComplete = true;
    }

    renderInteractionEventListeners() {
        const container = this.shadowRoot.querySelector('.media-container');
        const image = this.shadowRoot.querySelector('.image');
        const ptz = this.shadowRoot.querySelector('.ptz');
        const shortcuts = this.shadowRoot.querySelector('.shortcuts');
        const state = this.shadowRoot.querySelector('.state');

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

        if (image) {
            image.addEventListener('click', () => this.session?.fetchImage());
            this.onMouseDownHold(image, () => this.session?.fetchImage(), 800, 1000);
            this.onTouchHold(image, () => this.session?.fetchImage(), 800, 1000);
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
            shortcuts.addEventListener('click', ev => { this.buttonClick(ev.target); });
        }

        if (state) {
            state.addEventListener('click', ev => { this.buttonClick(ev.target); });
        }
 
    }

    handleSessionEvent(ev) {
        switch (ev.type) {
            case 'statuschange':
                this.updateVolume();
                this.updateMicrophone();
                this.updateStatus();
                break;

            case 'remotestream':
                // todo: revisit this.loadRemoteStream();
                break;
            case 'backgroundchange':
                if (!ev.detail.background) {
                    this.handleVisibilityChange(this.isVisibleInViewport, false);
                }
                this.updateVolume();
                break;
            case 'heartbeat':
                this.alive(true);
                this.updateStatus();
                this.updateVolume();
                break;
            case 'microphonechange':
                this.updateMicrophone();
                break;
            case 'imagechange':
                this.updateImage(ev.detail.image);
                break;
            case 'trace':
                this.appendTrace(ev.detail.message);
                break;
            case 'debug':
                this.setDebugVisibility(ev.detail.debug);
                break;
            case 'mute':
                if (ev.detail.mute) {
                    this.muteMedia();
                }
                else {
                    this.unmuteMedia();
                }
                this.updateStatus();
                this.updateVolume();
                break;
            case 'unmuteEnabled':
                if (this.media?.classList.contains('unmute-pending'))
                    this.unmuteMedia();
                break;
            case 'connected':
                if (ev.detail.connected)
                    this.loadRemoteStream(true);
                else
                    this.unloadRemoteStream();
                break;
            default:
                console.warn(`Unhandled session event type: ${ev.type}`);
                break;
        }
    }

    stopImmediatePropagation(ev) {
        ev.stopImmediatePropagation();
    }

    onMouseDownHold(element, callback, ms = 500, repeatDelay = undefined) {
        const attribute = 'mousedown';
        const cancel = (ev) => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        };

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

    onTouchHold(element, callback, ms = 500, repeatDelay = undefined) {
        const attribute = 'hold';
        const cancel = () => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        };
        element.addEventListener('touchstart', (ev) => {
            element.removeEventListener('click', this.stopImmediatePropagation, { capture: true, once: true });
            if (element.hasAttribute(attribute)) cancel();
            if (ev.touches.length > 1) {
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

    onDoubleTap(element, doubleTapCallback, ms = 500) {
        const attribute = 'doubletap';
        const cancel = () => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        };
        element.addEventListener('touchend', (ev) => {
            if (ev.touches.length > 0) {
                cancel();
                return;
            }
            if (element.hasAttribute(attribute)) {
                if (doubleTapCallback) {
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

    onMouseDoubleClick(element, doubleClickCallback, ms = 500) {
        const attribute = 'doubleclick';
        const cancel = () => {
            const timer = Number(element.getAttribute(attribute));
            element.removeAttribute(attribute);
            clearTimeout(timer);
        };
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
 

            case 'fullscreen':
                this.toggleFullScreen();
                break;

            case 'microphone':
                this.session.microphone = !this.session.microphone;
                break;

            case 'play':
                // e.g. un-pause or un-mute local media
                if (this.media?.paused) {
                    this.media.play().catch(err => this.trace(err.message));
                }
                break;

            case 'ptz':
                if (params && params.domain && params.service) {
                    this.session.hass.callService(params.domain, params.service, params.data);
                    setTimeout(() => { this.session?.fetchImage(); }, 2000);
                }
                break;

            case 'shortcut':
                if (params && params.domain && params.service) {
                    this.session.hass.callService(params.domain, params.service, params.data);
                }
                break;

            case 'volume':
                this.toggleVolume();
                break;
        }
    }

    buttonClick(button) {
        this.setPTZVisibility(true);

        if (button.icon === 'mdi:volume-high'
            || button.icon === 'mdi:volume-off'
            || button.icon === 'mdi:pin'
            || button.icon === 'mdi:pin-off'
            || button.classList.contains('ptz-volume')) {
            this.execute('volume');
            return;
        }
        if (button.icon === 'mdi:microphone'
            || button.icon === 'mdi:microphone-off'
            || button.classList.contains('ptz-microphone')) {
            this.execute('microphone');
            return;
        }
        if (button.icon === 'mdi:pause') {
            this.execute('play');
            return;
        }
        if (button.dataset.index !== undefined) {
            const shortcuts = this.config.shortcuts.services || this.config.shortcuts;
            const shortcut = shortcuts[button.dataset.index];
            if (shortcut && shortcut.service) {
                const [domain, service] = shortcut.service.split('.', 2);
                this.execute('shortcut', { domain: domain, service: service, data: (shortcut.service_data || {}) });
            }
            return;
        }

        const ptzData = this.config.ptz?.['data_' + button.className];
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

            if (newIcon === 'mdi:loading') {
                // Synchronize the spin animation based on current time
                const now = Date.now();
                const elapsed = now % 1000; 
                const animationDuration = 1000; 
                const negativeDelay = -(elapsed / animationDuration); 
    
                // Apply the negative animation-delay to synchronize
                stateIcon.style.animationDelay = `${negativeDelay}s`;
                stateIcon.style.animationDuration = '1s';
                stateIcon.style.animationTimingFunction = 'linear'; 
                stateIcon.style.animationIterationCount = 'infinite';
            }
        }

        if (visible || stateIcon.hasAttribute("error"))
            stateIcon.classList.add('show');
        else
            stateIcon.classList.remove('show');
    }

    get isPlaying() {
        
        const media = this.media;
        const session = this.session;
        if (!media || !session?.isStreaming)
            return false;

        const playing = (media.getAttribute('playing') === 'video' || media.getAttribute('playing') === 'audiovideo' || media.getAttribute('playing') === 'audio');
        return playing;
        
    }
 
    get isPaused() {
        const media = this.media;
        const paused = media && media.getAttribute('playing') === 'paused';
        return paused;
    }

    updateStatus() {

        if (!this.session || !this.session.status) {
            this.setIcon("mdi:heart-broken", false, null);
            this.updateImage(null);
            return;
        }
        if (this.session.isTerminated === true) {
            this.setIcon("mdi:emoticon-dead", false, null);
            this.updateImage(null);
            return;
        }
        if (this.config?.video === false && this.config?.audio === false) {
            // pure image mode => no streaming icon
            return;
        }

        const status = this.session.status;
        const media = this.media;
        const playing = this.isPlaying;
        const doesntplay = this.config.video === false && this.config.audio === false;
        const paused = this.isPaused;

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
                this.setIcon("mdi:alert-circle", true, this.session.lastError);
                return;

            case "disconnected":
                if (!this.waitStartDate)
                    this.waitStartDate = Date.now();
                // fall through
            case "connecting":
                iconToShow = (media?.tagName === 'AUDIO') ? "mdi:volume-mute" : "mdi:loading";
                setTimeout(() => this.updateStatus(), waitedTooLong);
                break;

            default:
                break;
        }

        if (playing) {
            this.waitStartDate = null;
            if (this.config.stats || WebRTCsession.globalStats) {
                this.header = this.session?.state?.statistics ?? "";
            }
            else {
                this.header = "";
            }
            this.setIcon(null, false);
            iconToShow = (media?.tagName === 'AUDIO') ? "mdi:volume-high" : "mdi:play";
        }
        else if (paused) {
            iconToShow = (media?.tagName === 'AUDIO') ? "mdi:volume-off" : "mdi:pause";
        }

        if (this.session.isStreaming) {
            if (media?.tagName == 'AUDIO') {
                if (this.session.background) 
                    this.setIcon("mdi:pin", true);
                else if (media.muted && this.config.muted === false) 
                    this.setIcon(iconToShow, true);
                else 
                    this.setIcon(iconToShow, false);
            }
            else {
                switch (media?.getAttribute('playing')) {
                    case 'paused':
                        this.setIcon(iconToShow, true);
                        break;
                    case 'video':
                        if (this.session.background) 
                            this.setIcon("mdi:pin", true);
                        else
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
            // not streaming or not yet started 
            if (this.waitStartDate && (Date.now() >= this.waitStartDate + waitedTooLong)) {
                this.setIcon(iconToShow, true);
            } else {
                this.setIcon(iconToShow, false);
            }
        }
    }

    updateImage(data) {
        const image = this.shadowRoot.querySelector('.image');
        if (!image) return;
        if (image.getAttribute('timestamp') === data?.timestamp) return;

        if (!data) {
            image.removeAttribute('size');
            image.removeAttribute('timestamp');
            image.src = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E";
            return;
        }

        image.addEventListener('load', () => {
            if (image.hasAttribute('timestamp'))
                URL.revokeObjectURL(image.src);
        }, { once: true });

        image.setAttribute('timestamp', data.timestamp);
        image.setAttribute('size', data.size);
        image.src = URL.createObjectURL(data.blob);
    }

    updateVolume() {
        const volume = this.shadowRoot.querySelector('.volume');
        if (!volume) return;
    
        let icon = null; 
    
        if (!this.session || !this.session.isStreaming) {
            // No icon to display without an active stream 
            icon = null; 
        }
        else if (this.session.background) {
            // Background mode enabled
            icon = 'mdi:pin';
        }
        else if (this.config.audio === false || (this.session.isStreaming && !this.session.isStreamingAudio)) {
            // No audio stream available
            
            if (this.config.background || this.config.allow_background)
                // Background mode can be enabled
                icon = 'mdi:pin-off';  
        }
        else if (this.media.tagName === 'AUDIO') {
            // Audio only media
            
            if (this.media.muted || !this.session.isStreamingAudio)  
                // Muted or not active stream
                icon = 'mdi:volume-off';
            else
                // Unmuted audio
                icon = 'mdi:volume-high';
        }
        else if (this.session.isStreaming) {
            // Video stream with audio

            if (this.media.muted)
                icon = 'mdi:volume-off';
            else
                icon = 'mdi:volume-high';
        }
    
        if (icon)
            volume.parentNode.classList.remove('hidden');
        else
            volume.parentNode.classList.add('hidden'); 

        volume.icon = icon;
    }
    
    updateMicrophone() {
        const enabled = this.session.microphone;
        const mic = this.shadowRoot.querySelector('.microphone');
        if (!mic) return;
        if (enabled) {
            mic.icon = 'mdi:microphone';
        }
        else {
            mic.icon = 'mdi:microphone-off';
        }
    }

    trace(text, o) {
        if (this.session?.tracing === false)
            return;

        text = `${this.instanceId} ${text}`;
        if (this.session)  {
            this.session.trace(text, o);
        }
        else
        {
            if (o)
                console.debug(text, o);
            else
                console.debug(text);

            this.appendTrace(text);
        }
    }

    appendTrace(message) {
        if (this.session?.tracing === false)
            return;

            const log = this.shadowRoot.querySelector('.log');
            if (!log) return;

            const max_entries = 1000;
            const min_entries = 500;

            log.insertAdjacentHTML('beforeend', `${this.instanceId} ${message.replace("\n", "<br>")}<br>`);
            if (log.childNodes.length > max_entries) {
                while (log.childNodes.length > min_entries) {
                    log.removeChild(log.firstChild);
                }
            }
            log.scrollTop = log.scrollHeight;
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
        this.assertConfigValid(config);
        this._cardConfig = config;
    }

    assertConfigValid(config) {
        if (!('RTCPeerConnection' in window) && (config.video !== false || config.audio !== false)) {
            throw new Error("Browser does not support WebRTC");
        }
        if (!config.url || !config.entity) {
            throw new Error("Missing `url` or `entity`");
        }
        //return this.hass?.states && this.hass.states[this._cardConfig.entity];

        if (config.ptz && !config.ptz.service) {
            throw new Error("Missing `service` for `ptz`");
        }
    }

    set hass(hass) {
        if (!this.session) return;
        this.session.hass = hass;
    }

    handleVisibilityChange(visible, allow_background = undefined) {

        const mediaEventTypes = [
            'emptied',
            'pause',
            'canplay',
            'play',
            'playing',
            'volumechange',
            'dblclick',
            'click',
            'error',
        ];
        const media = this.media;
        
        this.trace(`Visibility changed: ${visible}`);
        if (visible) {

            if (!this.mediaEventHandlersRegistered) {
                mediaEventTypes.forEach(event => {
                    media.addEventListener(event, this.handleMediaEvent);
                });
                this.mediaEventHandlersRegistered = true;
            }

            if (!this.session) {
                let key = WebRTCsession.key(this._cardConfig);
                this._session = WebRTCsession.sessions.get(key);
                if (!this._session) {
                    const configClone = JSON.parse(JSON.stringify(this._cardConfig));
                    this._session = WebRTCsession.create(configClone);
                }
            }

            this.session.attachCard(this, this.handleSessionEvent);

            if (this.session?.background && this.config.muted !== true)
                this.unmuteMedia();
    
            this.loadRemoteStream();
            this.updateVolume();
            this.updateStatus();
            this.updateMicrophone();
        }
        else if (allow_background && this.session?.background)
        {
            [...this.session.state.cards].forEach(otherCard => {
                if (otherCard !== this && otherCard.isVisibleInViewport === false) {
                    debugger;
                    otherCard.handleVisibilityChange(false, false);
                }
            });
        }
        else {

            if (this.mediaEventHandlersRegistered) {
                mediaEventTypes.forEach(event => {
                    media.removeEventListener(event, this.handleMediaEvent);
                });
                this.mediaEventHandlersRegistered = false;
            }

            this.session?.detachCard(this, this.handleSessionEvent);
            this._session = null;

            this.setControlsVisibility(false);
            this.setPTZVisibility(false);

            this.waitStartDate = null;
            this.unloadRemoteStream();
        }
    }
   
    handleWindowFocus() {
        const entries = this.visibilityObserver?.takeRecords?.() ?? [];
        if (entries.length) {
            this.updateVisibility(entries);
        } else {
            this.visibilityObserver?.unobserve(this);
            this.visibilityObserver?.observe(this);
        }
    }

    handleDocumentVisibility() {
        if (document.hidden) {
            this.isVisibleInViewport = false;
            this.handleVisibilityChange(false, this.config?.allow_background);
        }
    }

    handleDocumentClick() {
        WebRTCsession.enableUnmute();
    }

    registerExternalListeners() {
        if (this.observersActive) return;

        this.observersActive = true;

        this.updateVisibility = (entries) => {
            const isIntersecting = entries[entries.length - 1].isIntersecting;
            if (this.isVisibleInViewport !== isIntersecting) {
                this.isVisibleInViewport = isIntersecting
                if (document.fullscreenElement) return;

                this.handleVisibilityChange(this.isVisibleInViewport, this.config?.allow_background);
            }
        };

        this.visibilityObserver = new IntersectionObserver(this.updateVisibility, { threshold: 0 });
        this.visibilityObserver.observe(this); 

        const container = this.shadowRoot.querySelector('.media-container');
        const ptz = this.shadowRoot.querySelector('.ptz');
        const ptzStyle = ptz ? window.getComputedStyle(ptz) : null;
        if (ptzStyle) {
            const ptzHeight = Number(ptzStyle.getPropertyValue("--ptz-height").replace('px', ''));
            const resize = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const { inlineSize: width, blockSize: availableheight } = entry.contentBoxSize[0];
                    if (availableheight > 0) {
                        let scale;
                        if (ptzHeight > availableheight)
                            scale = availableheight / ptzHeight;
                        else if (window.matchMedia("(pointer: fine)").matches)
                            scale = 1;
                        else
                            scale = 1;
                        this.style.setProperty(`--ptz-scale`, `${scale}`);
                    }
                }
            });
            resize.observe(container);
            this.resizeObserver = resize;
        }

        window.addEventListener('focus', this.handleWindowFocus);
        document.addEventListener("visibilitychange", this.handleDocumentVisibility);
        document.addEventListener('click', this.handleDocumentClick, { once: true, capture: true }); 
    }

    unregisterExternalListeners() {
        if (!this.observersActive) return;

        this.updateVisibility = noop;

        this.visibilityObserver?.disconnect();
        this.visibilityObserver = null;

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        window.removeEventListener('focus', this.handleWindowFocus);
        document.removeEventListener("visibilitychange", this.handleDocumentVisibility);
        document.removeEventListener('click', this.handleDocumentClick, { once: true, capture: true });

        this.observersActive = false; 
    }

    /** 
    * Render new card (destructive) 
    */
    render() {

        if (this.shadowRoot) {
            while (this.shadowRoot.firstChild) {
                this.shadowRoot.removeChild(this.shadowRoot.firstChild);
            }
            this.rendered = false;
        } else {
            // Create the shadowRoot if it doesn't exist
            this.attachShadow({ mode: 'open' });
        }
    
        const video = this.config.video;
        const muted = this.config.muted;
        const background = this.config.background || this.session?.background;
        const hasMove = this.config.ptz?.data_right;
        const hasZoom = this.config.ptz?.data_zoom_in;
        const hasHome = this.config.ptz?.data_home;
        const hasVol = this.config.audio !== false;
        const hasMic = this.config.microphone;
        const services = this.config.shortcuts?.services || this.config.shortcuts;
        const userCardStyle = this.config.style;

        if (!this.rendered) {
            this.renderCard(video, muted, background);
            this.renderPTZ(hasMove,hasZoom,hasHome,hasVol,hasMic);
            this.renderShortcuts(services);
            this.renderStyle(userCardStyle);
            this.renderInteractionEventListeners();
            this.rendered = true;
        }
    }

    connectedCallback() {

        WebRTCbabycam.globalInit();

        if (this.session?.state?.cards?.has(this))
            // card running in the background
            return;

        this.render();
        this.registerExternalListeners(); 

        setTimeout(() => {
            this.setControlsVisibility(false);
            this.setPTZVisibility(false);
            this.setDebugVisibility(WebRTCsession.globalDebug || this.config.debug);
        });
    }

    disconnectedCallback() {
        this.unregisterExternalListeners();
        this.isVisibleInViewport = false;
        this.handleVisibilityChange(false, this.config?.allow_background);
    }

    loadRemoteStream(play = false) {

        const media = this.media;
        const remoteStream = this.session?.state?.call?.remoteStream;
        
        if (!media || !remoteStream) return;

        if (media.srcObject === remoteStream) {
            media.setAttribute('loaded', Date.now());
            this.trace("Reloading remote media stream");
            return;
        }

        this.trace("Loading remote media stream");

        media.setAttribute('loaded', Date.now());
        media.srcObject = remoteStream;

        if (play && this.session.isStreaming && !this.isPlaying) {
            this.playMedia();
        }
    }

    unloadRemoteStream() {
        const media = this.media;
        if (media) {
            media.removeAttribute('playing');
            media.removeAttribute('loaded');
            media.srcObject = null;
            this.trace("Unloaded remote media");
        }
    }

    alive(on) {

        const container = this.shadowRoot?.querySelector(".media-container");
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
            this.shadowRoot.querySelector('.card').insertAdjacentHTML('beforebegin', style);

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


    unmuteMedia() {
        const media = this.media;
        if (!media) return;

        if (media.muted) {
            if (WebRTCsession.unmuteEnabled) {
                media.classList.remove('unmute-pending');
                media.muted = false;
            }
            else {
                // Browser won't play unmuted audio, save intention and unmute when enabled
                media.classList.add('unmute-pending');
            }
        }
        this.updateStatus();
        this.updateVolume();
    }

    muteMedia() {
        const media = this.media;
        if (!media) return;

        media.classList.remove('unmute-pending');
        media.muted = true;
        this.updateStatus();
        this.updateVolume();
    }
            
    toggleVolume() {

        const media = this.media;
        if (!media) return;

        const allowBackground = this.session?.background || this.config?.allow_background || this.config?.background;
        const allowMute = this.config?.allow_mute ?? true;

        if (this.session?.background) {
            this.trace("Exiting background mode");
            this.session.background = false;

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
        if (this.session && allowBackground) {
            this.trace("Enabling background mode");
            this.session.background = true;
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

    playMedia(playMuted = undefined) {

        if (this.session.isTerminated) return;
 
        const media = this.media;

        if (!media.srcObject) {
            this.trace('Cannot play media without source stream');
            return;
        }

        let mute = media.muted;
        if (playMuted === true) {
            mute = true;
        }
        else if (playMuted === false) {
            mute = false;
        }
        else if (media.classList.contains('unmute-pending')) {
            mute = false;
        }
        
        if (mute && media.tagName == 'AUDIO') {
            // do not attempt to play muted audio 
            return;
        }

        if (!mute && !WebRTCsession.unmuteEnabled)
        {
            // avoid browser wrath
            mute = true;
            media.classList.add('unmute-pending');
        }

        if (media.muted != mute)
            media.muted = mute;

        media.classList.add('pause-pending');

        this.trace(`Media play call muted=${media.muted}, unmuteEnabled=${WebRTCsession.unmuteEnabled}`);
 
        media.play()
            .then(_ => {
                if (!media.muted) {
                    media.classList.remove('unmute-pending');
                    WebRTCsession.enableUnmute();
                }
                media.classList.remove('pause-pending');
            })
            .catch(err => {
                if (err.name == "NotAllowedError" && !media.muted && playMuted != true) {
                    WebRTCsession.unmuteEnabled = false;

                    media.classList.add('unmute-pending');
                    this.trace(`${err.message}`);
                    this.trace('Unmuted play failed');
                    
                    this.media?.play();
                     
                }
                else if (err.name === "AbortError") {
                    this.trace(`Media play aborted: ${err.message}`);
                }
                else {
                    this.trace(`Media play failed: ${err.message}`);
                }
            });
    }

    
    createMedia(video, muted, background) {
        let media;
        if (video === false) {
            media = document.createElement('audio');
        }
        else {
            media = document.createElement('video');
        }

        media.className = 'media';
        media.setAttribute('playsinline', '');
        media.playsinline = true;

        media.setAttribute('muted', '');

        if (muted === false || (background === true && muted !== true)) {
            media.classList.add('unmute-pending');
        }
   
        media.muted = true;
        media.controls = false;
        media.autoplay = false;

        this.trace(`Created ${media.tagName.toLowerCase()} element`);
        return media;
    }
 
    // General handler for media events
    handleMediaEvent(ev) {

        this.trace(`Media ${ev.type}`);
        switch (ev.type) {
            case 'emptied':
                this.alive(false);
                this.media.removeAttribute('playing');
                break;

            case 'pause':
                this.alive(false);
                if (this.session.isTerminated) return;

                const media = this.media;
                media.setAttribute('playing', 'paused');
                this.updateStatus();
                this.updateVolume();
        
                if (media.classList.contains('pause-pending')) {
                    media.classList.remove('pause-pending');
                    return;
                }
        
                // Override default media element behavior: disable pause for live streams 
                const shouldAllowPause = (media.controls && this.config.allow_pause);
        
                if (media.tagName === 'AUDIO') {
                    if (shouldAllowPause) {
                        // Override default audio element behavior: mute on pause
                        media.muted = true;
                    }
                    else if (media.muted === false) {
                        this.trace('Unpausing audio');
                        this.playMedia();
                    }
                    return;
                }
        
                if (!shouldAllowPause) {
                    this.trace('Unpausing video');
                    this.playMedia();
                }
                break;

            case 'canplay':
                // Autoplay implementation
                this.playMedia();
                break;

            case 'play':
                if (this.config.muted === false && this.media.tagName === 'AUDIO') {
                    // Override default audio element behavior: unmute on play
                    this.unmuteMedia();
                }
                
                this.playTimeoutId = setTimeout(() => {
                    
                    if (!this.isPlaying || !this.session?.isStreaming)
                        if (!this.session?.isAnyCardPlaying) {
                            this.unloadRemoteStream();
                            this.trace('Play render timeout');
                            this.session?.restart();
                        }

                }, WebRTCsession.TIMEOUT_RENDERING);

                break;

            case 'playing':

                clearTimeout(this.playTimeoutId);

                if (this.media.tagName === 'AUDIO') {
                    this.media.setAttribute('playing', 'audio');
                    this.alive(true);
                    this.updateStatus(); 
                    this.updateVolume();
                    return;
                }

                if (this.session.isStreamingAudio)
                    this.media.setAttribute('playing', 'audiovideo');
                else
                    this.media.setAttribute('playing', 'video');
        
                const w = this.media.videoWidth || 0;
                const h = this.media.videoHeight || 0;
                let aspectRatio = 0;
                if (h > 0) {
                    aspectRatio = (w / h).toFixed(4);
                }
                this.media.setAttribute("aspect-ratio", aspectRatio);
                this.media.style.setProperty(`--video-aspect-ratio`, `${aspectRatio}`);
        
                if (!this.session.isStreamingAudio)
                    this.media.classList.remove('unmute-pending');
        
                this.alive(true);
                this.updateStatus(); 
                this.updateVolume();
                break;

            case 'volumechange':
                if (this.media.tagName === 'AUDIO') {
                    // Override default audio element behavior: mute controls play/pause
                    if (this.media.muted)
                        this.pauseMedia();
                    else
                        this.playMedia();
        
                    if (this.media.controls)
                        this.setControlsVisibility(true);
                }
                this.updateVolume();
                break;

            case 'dblclick':
                  // Prevent double fullscreen in Chrome
                ev.preventDefault();

                setTimeout(() => {
                    this.setControlsVisibility(false);
                }, 100);
                break;

            case 'click':
                WebRTCsession.enableUnmute();
                if (this.media.controls) {
                    this.setControlsVisibility(true);
                }
                break;

            case 'error':
                this.lastError = this.media.error.message;
                this.trace(`Media error ${this.media.error.code}; details: ${this.media.error.message}`);
                //this.setStatus('error');
                break;

            default:
                this.trace(`Unhandled media event: ${ev.type}`);
        }
    }

 
}

customElements.define('webrtc-babycam', WebRTCbabycam);

// Register the card for Home Assistant
const customCardRegistrationFinal = {
    type: 'webrtc-babycam',
    name: 'WebRTC Baby Camera',
    preview: false,
    description: 'WebRTC babycam provides a lag-free 2-way audio, video, and image camera card.'
};
if (window.customCards) window.customCards.push(customCardRegistrationFinal);
else window.customCards = [customCardRegistrationFinal];

// Signaling Channel classes:
class SignalingChannel {
    constructor() {
        this._oncandidate = null;
        this._onanswer = null;
        this._onoffer = null;
        this._onerror = null;
        this._ontrace = null;
    }
    
    /**
     * Opens the signaling channel.
     * @param {number} timeout - Timeout in ms.
     */
    async open(timeout) { }

    /**
     * Closes the signaling channel.
     */    
    close() { }

    /**
     * Sends an SDP answer.
     * @param {RTCSessionDescriptionInit} rtcSessionDescription 
     */
    async sendAnswer(rtcSessionDescription) { }

    /**
     * Sends an ICE candidate.
     * @param {RTCIceCandidateInit} rtcIceCandidate 
     */
    async sendCandidate(rtcIceCandidate) { }

    /**
     * Sends an SDP offer.
     * @param {RTCSessionDescriptionInit} rtcSessionDescription 
     */
    async sendOffer(rtcSessionDescription) { }

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
}

class WhepSignalingChannel extends SignalingChannel {
    constructor(url, timeout = 30000) {
        super();
        this.url = url;
        this.httpTimeoutId = undefined;
        this.timeout = timeout;
        this.eTag = '';
        this.offerData = null;
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
    async sendCandidate(candidates) {
        if (!this.offerData) {
            if (this.onerror) this.onerror(new Error('Offer data not set before sending candidates.'));
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
            if (response.status !== 204) {
                throw new Error(`sendCandidate bad status code ${response.status}`);
            }
        }
        catch (err) {
            if (this.onerror) this.onerror(err);
        }
    }
    async sendOffer(desc) {
        this.close();
        this.offerData = this.parseOffer(desc.sdp);
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
        this.handleMessage = this.handleMessage.bind(this);
        this.handleOpen = this.handleOpen.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handleClose = this.handleClose.bind(this);
    }
    get isOpen() {
        return this.ws != null && this.ws.readyState === WebSocket.OPEN;
    }
    async open(timeout) {
        return new Promise((resolve, reject) => {
            if (this.ws) {
                reject(new Error("WebSocket is already open."));
                return;
            }
            const ws = new WebSocket(this.url);
            ws.binaryType = "arraybuffer";
            ws.addEventListener('message', this.handleMessage);
            ws.addEventListener('open', this.handleOpen);
            ws.addEventListener('error', this.handleError);
            ws.addEventListener('close', this.handleClose);
            this.ws = ws;
            this.websocketTimeoutId = setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CLOSING) {
                    ws.close();
                    if (this.onerror) {
                        this.onerror(new Error(`WebSocket connection timed out after ${timeout}ms`));
                    }
                    reject(new Error(`WebSocket connection timed out after ${timeout}ms`));
                }
            }, timeout);
            this._resolveOpen = resolve;
            this._rejectOpen = reject;
        });
    }
    close() {
        const ws = this.ws;
        if (ws) {
            if (this.websocketTimeoutId) {
                clearTimeout(this.websocketTimeoutId);
                this.websocketTimeoutId = undefined;
            }
            this.trace(`Closing websocket in ${ws.readyState} state`);
            if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(ws.readyState)) {
                ws.close();
            }
            ws.removeEventListener('message', this.handleMessage);
            ws.removeEventListener('open', this.handleOpen);
            ws.removeEventListener('error', this.handleError);
            ws.removeEventListener('close', this.handleClose);
            this.ws = null;
        }
    }
    async sendCandidate(rtcIceCandidate) {
        if (!this.isOpen) throw new Error(`Cannot send candidate from closed WebSocket`);
        const message = {
            type: "webrtc/candidate",
            value: rtcIceCandidate ? rtcIceCandidate.candidate : ""
        };
        this.ws.send(JSON.stringify(message));
    }
    async sendOffer(rtcSessionDescription) {
        if (!this.isOpen) throw new Error(`Cannot send offer from closed WebSocket`);
        const message = {
            type: 'webrtc/offer',
            value: rtcSessionDescription.sdp
        };
        this.ws.send(JSON.stringify(message));
    }
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
                    break;
            }
        } else {
            console.warn("Received binary data which is not handled:", ev.data);
        }
    }
    handleOpen() {
        if (this.websocketTimeoutId) {
            clearTimeout(this.websocketTimeoutId);
            this.websocketTimeoutId = undefined;
        }
        if (this._resolveOpen) {
            this._resolveOpen();
            this._resolveOpen = null;
            this._rejectOpen = null;
        }
        this.trace(`WebSocket signaling channel opened`);
    }
    handleError() {
        if (this.websocketTimeoutId) {
            clearTimeout(this.websocketTimeoutId);
            this.websocketTimeoutId = undefined;
        }
        if (this._rejectOpen) {
            this._rejectOpen(new Error("WebSocket encountered an error"));
            this._resolveOpen = null;
            this._rejectOpen = null;
        }
        if (this.onerror) {
            this.onerror(new Error("WebSocket encountered an error"));
        }
        this.close();
    }
    handleClose() {
        this.trace(`WebSocket signaling channel closed`);
        this.ws = null;
        if (this._rejectOpen) {
            this._rejectOpen(new Error("WebSocket connection was closed before opening"));
            this._resolveOpen = null;
            this._rejectOpen = null;
        }
    }
    trace(message) {
        if (this.ontrace)
            this.ontrace(message);
    }
}

class RTSPtoWebSignalingChannel extends SignalingChannel {
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
            const data = "data=" + encodeURIComponent(rtcSessionDescription.sdp);
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
                        this.onanswer({ type: "answer", sdp: decodeURIComponent(stringValue) });
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

