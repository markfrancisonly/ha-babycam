console.info(
    `%c  WebRTC Babycam \n%c`,
    'color: orange; font-weight: bold; background: black',
    'color: white; font-weight: bold; background: dimgray',
);

const noop = () => {};
window.webrtcSessions = window.webrtcSessions ?? new Map();

/**
 * WebRTC Babycam Custom Element
 * Provides a lag-free 2-way audio, video, and image camera card.
 */
class WebRTCsession {
    static unmuteEnabled = undefined;

    static globalDebug = (() => {
        const value = (new URLSearchParams(window.location.search)).get('debug');
        return value !== null ? value.toLowerCase() !== 'false' : undefined;
    })();
    
    static globalStats = (() => {
        const value = (new URLSearchParams(window.location.search)).get('stats');
        return value !== null ? value.toLowerCase() !== 'false' : undefined;
    })();

    // Timeout configurations in milliseconds
    static SIGNALING_TIMEOUT_MS = 10000;
    static ICE_TIMEOUT_MS = 10000;
    static RENDERING_TIMEOUT_MS = 10000;
    static IMAGE_FETCH_TIMEOUT_MS = 10000;
    static IMAGE_FETCH_INTERVAL_MS = 3000;
    static IMAGE_EXPIRY_MS = 30000;
    static IMAGE_EXPIRY_RETRIES = 10;
    static SESSION_TERMINATION_DELAY_MS = WebRTCsession.IMAGE_FETCH_INTERVAL_MS;

    constructor(key, hass, config) {
        if (!config || !config.entity) {
            throw new Error("Entity configuration is required but entity needn't exist");
        }

        this.key = key;
        this.hass = hass;
        this.config = config;

        this.state = {
            cards: new Set(),
            image: null,
            statistics: "",
            status: 'uninitialized',
            calls: new Map(),
            activeCall: null
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

    static get sessions() { 
        return window.webrtcSessions;
    }

    static key(config) {
        let key = config.entity.replace(/[^a-z0-9A-Z_-]/g, '-');

        // todo: move defaults out of constructor
        if (config.audio === false) key += '-a';
        if (config.video === false) key += '-v';

        return key;
    }

    static getInstance(config) {
        let hass = document.body.querySelector("home-assistant")?.hass;
        let key = WebRTCsession.key(config);
        let session = WebRTCsession.sessions.get(key);
        if (!session) {
            session = new WebRTCsession(key, hass, config);
            WebRTCsession.sessions.set(key, session);
            console.debug(`****** created session ${key} #${WebRTCsession.sessions.size}`);
        }
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

    async getPeerConnectionStats(call) {
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

        try {
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

            if (this.config.video === true) {
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

    get activeCall() {
        return this.state.activeCall;
    }

    get isAnyCardPlaying() {
        const hasCardPlaying = [...this.state.cards].some(card => card.isPlaying === true);
        return hasCardPlaying;
    }

    get isAnyCardPlayingVideo() {
        const hasCardPlayingVideo = [...this.state.cards].some(card => card.isPlayingVideo === true);
        return hasCardPlayingVideo;
    }

    get isStatsEnabled() {
        return WebRTCsession.globalStats || [...this.state.cards].some(card => card.config.stats);
    }

    /**
     * Retrieves the smallest 'interval' value from all attached cards.
     * If no intervals are defined, returns undefined.
     * @returns {number} The minimum interval or default if none are set.
     */
    getMinCardImageInterval() {
        const intervals = Array.from(this.state.cards)
            .map(card => card.config.image_interval)
            .filter(image_interval => typeof image_interval === 'number');

        if (intervals.length === 0) {
            return WebRTCsession.IMAGE_FETCH_INTERVAL_MS;
        }

        const interval = Math.min(...intervals);
        return Math.max(10, interval);
    }
    
    imageLoop() {
        if (this.imageLoopTimeoutId) {
            return;
        }
        else if (this.isTerminated) {
            this.imageLoopTimeoutId = undefined;
            return;
        }

        const interval = this.getMinCardImageInterval();
        if (interval == 0) return;

        this.imageLoopTimeoutId = setTimeout(() => {
            this.imageLoopTimeoutId = undefined;
            this.imageLoop();
        }, interval);

        if (this.isAnyCardPlayingVideo) return;
        this.fetchImage();
    }

    async play(id = undefined) {
        if (id !== this.watchdogTimeoutId) {
            return;
        }

        let call = null;

        try {

            call = this.activeCall;
            const live = call && this.isStreaming && (this.config.video === false || this.isAnyCardPlaying);
            const isStatsEnabled = this.isStatsEnabled;

            if (!id) {
                this.imageLoopTimeoutId = undefined;
                this.setStatus('reset');
                this.resetStats();
            }

            this.imageLoop();

            if (this.config.video === false && this.config.audio === false) {
                // WebRTC disabled by configuration
            }           
            else if (!call || call.reconnectDate === 0) {
                call = await this.startCall();
                this.state.activeCall = call;
            }
            else if (Date.now() < call.reconnectDate) {
                // Connecting or previously connected, extend reconnection if streaming
                if (live) {
                    this.extendCallTimeout(call, WebRTCsession.RENDERING_TIMEOUT_MS);
                    if (isStatsEnabled) {
                        await this.getPeerConnectionStats(call);
                    }
                }
            }
            else {
                this.trace(`Play watchdog timeout`);
                await this.endCall(call);
                call = null;
            }

            if (isStatsEnabled) {
                await this.updateStatistics();
            }
            this.eventTarget.dispatchEvent(new CustomEvent('heartbeat', { detail: {live: live} }));

        }
        catch (err) {
            this.lastError = err.message;
            this.trace(`Play ${err.name}: ${err.message}`);
        }
        finally {
            const now = Date.now();
            const intervalRemaining = 1000 - (now % 1000);
            const timeoutRemaining = call ? call.reconnectDate - now : intervalRemaining;
            const loopDelay = Math.max(0, Math.min(intervalRemaining, timeoutRemaining));

            clearTimeout(this.watchdogTimeoutId);
            const loopId = setTimeout(() => this.play(loopId), loopDelay);
            this.watchdogTimeoutId = loopId;
        }
    }

    extendCallTimeout(call, ms = 0) {
        if (!call) return;
        call.reconnectDate = Math.max(Date.now() + ms, call.reconnectDate);
    }

    timeoutCall(call) { 
        if (!call) return;
        call.reconnectDate = 0;
    }

    async restartCall(call) {
        // todo: handle rekey for video, audio, microphone changes

        call = call ?? this.activeCall;
        if (!call) return;

        this.extendCallTimeout(call, WebRTCsession.SIGNALING_TIMEOUT_MS);
        await this.endCall(call);

        clearTimeout(this.watchdogTimeoutId);
        this.watchdogTimeoutId = undefined;
        this.timeoutCall(call);
        
        this.trace('Restarting call');
        this.play();
    }

    async terminate() {
        clearTimeout(this.watchdogTimeoutId);
        clearTimeout(this.imageLoopTimeoutId);
        clearTimeout(this.fetchImageTimeoutId);
        clearTimeout(this.terminationTimeoutId);
        
        this.watchdogTimeoutId = undefined;
        this.imageLoopTimeoutId = undefined;
        this.fetchImageTimeoutId = undefined;
        this.terminationTimeoutId = undefined;

        for (const call of [...this.state.calls.values()]) {
            await this.endCall(call);
        }

        this.setStatus('terminated');
    }

    attachCard(card, messageHandler) {

        this.trace(`Attaching new card ${card.instanceId} to session`);

        if (this.background) {
            card.releaseOtherBackgroundCards();
        }

        if (this.terminationTimeoutId) {
            clearTimeout(this.terminationTimeoutId);
            this.terminationTimeoutId = null;
            this.trace("Scheduled termination aborted due to session attachment");
        }

        if (this.state.cards.has(card)) return;

        this.state.cards.add(card);

        const sessionEventTypes = [
            'status',
            'remotestream',
            'background',
            'heartbeat',
            'microphone',
            'image',
            'trace',
            'debug',
            'stats',
            'mute',
            'unmuteEnabled',
            'connected',
        ];
        
        sessionEventTypes.forEach(type => {
            this.eventTarget.addEventListener(type, messageHandler);
        });

        this.tracing = this.tracing || card.config.debug || WebRTCsession.globalDebug;

        if (card.isVisibleInViewport || this.background) {
            this.play();
        } else {
            this.trace("attachCard: card is not visible & background=false => not playing");
        }
    }

    detachCard(card, messageHandler) {
        if (!this.state.cards.has(card)) {
            this.trace("detachCard: Card mismatch or already detached; skipping");
            return;
        }

        const sessionEventTypes = [
            'status',
            'remotestream',
            'background',
            'heartbeat',
            'microphone',
            'image',
            'trace',
            'debug',
            'stats',
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
            this.trace(`Detached ${card.instanceId}, cards remaining in this session: ${remaining}`);
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
        }, WebRTCsession.SESSION_TERMINATION_DELAY_MS);
        this.trace("Termination scheduled");
    }
    
    /**
     * Invoked whenever the browser is expected to allow unmuted audio play 
     */
    static async enableUnmute(value = true) {
        if (WebRTCsession.unmuteEnabled === value) return;

        WebRTCsession.unmuteEnabled = value;
        console.debug(`Unmute ${WebRTCsession.unmuteEnabled ? 'enabled' : 'disabled'}`);

        const sessions = [...WebRTCsession.sessions.values()];
        for (const session of sessions) {
            session.eventTarget.dispatchEvent(new CustomEvent('unmuteEnabled', { detail: { unmuteEnabled: value } }));
        }
    }
        
    static async toggleGlobalMute() {
        WebRTCsession.globalMute = !WebRTCsession.globalMute;
        console.debug(`Global mute ${WebRTCsession.globalMute ? 'enabled' : 'disabled'}`);
        
        const sessions = [...WebRTCsession.sessions.values()];
        for (const session of sessions) {
            session.eventTarget.dispatchEvent(new CustomEvent('mute', { detail: { mute: WebRTCsession.globalMute } }));
        }
    }

    static async toggleGlobalDebug() {
        WebRTCsession.globalDebug = !WebRTCsession.globalDebug;
        console.debug(`Global debug mode ${WebRTCsession.globalDebug ? 'enabled' : 'disabled'}`);
        
        const sessions = [...WebRTCsession.sessions.values()];
        for (const session of sessions) {
            session.tracing =  WebRTCsession.globalDebug;
            session.eventTarget.dispatchEvent(new CustomEvent('debug', { detail: { debug: WebRTCsession.globalDebug } }));
        }
    }
    
    static async toggleGlobalStats() {
        WebRTCsession.globalStats = !WebRTCsession.globalStats;
        console.debug(`Global stats mode ${WebRTCsession.globalStats ? 'enabled' : 'disabled'}`); 

        const sessions = [...WebRTCsession.sessions.values()];
        for (const session of sessions) {
            session.eventTarget.dispatchEvent(new CustomEvent('stats', { detail: { stats: WebRTCsession.globalStats } }));
        }
    }

    _trace(message, o) {
        const call = this.activeCall;
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
  
    set tracing(enabled) {
        if (enabled)
            this.trace = this._trace.bind(this);
        else
            this.trace = noop;
    }

    get tracing() {
        return this.trace !== noop;
    }

    setStatus(value) {
        if (this.state.status === value) return;
        this.state.status = value;
        this.trace(`STATE ${value}`);
        this.eventTarget.dispatchEvent(new CustomEvent('status', { detail: { status: value } }));
    }

    get status() {
        return this.state.status;
    }
        
    get background() {
        return localStorage.getItem(`webrtc.${this.key}.background`)?.toLowerCase() === 'true';
    }

    set background(value) {
        localStorage.setItem(`webrtc.${this.key}.background`, value);
        this.eventTarget.dispatchEvent(new CustomEvent('background', { detail: { background: value } }));
    }

    get microphone() {
        return localStorage.getItem(`webrtc.${this.key}.microphone`)?.toLowerCase() === 'true';
    }

    set microphone(value) {
        localStorage.setItem(`webrtc.${this.key}.microphone`, value);        
        if (this.isStreaming)
            this.restartCall();
        this.eventTarget.dispatchEvent(new CustomEvent('microphone', { detail: { microphone: value } }));
    }

    get isTerminated() {
        return this.state.status == 'terminated';
    }

    get isStreaming() {
        const call = this.activeCall;
        if (!call) return false;

        const pc = call.peerConnection;
        if (!pc) return false;
    
        const iceState = pc.iceConnectionState;
        if (!(iceState === "connected" || iceState === "completed")) return false;
    
        const remoteStream = call.remoteStream;
        if (!remoteStream) return false;
    
        const hasActiveTracks = remoteStream.getTracks().some(track => track.readyState === 'live');
        return hasActiveTracks;
    }

    get isStreamingAudio() {
        const call = this.activeCall;
        if (!call) return false;

        const remoteStream = call.remoteStream;
        if (!remoteStream) return false;
    
        const audioTracks = remoteStream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) return false;
    
        return audioTracks.some(track => track.readyState === 'live');
    }

    async startCall() {
        const { config } = this;

        if (config.video === false && config.audio === false) {
            this.trace('WebRTC disabled');
            return;
        }
        
        for (const call of [...this.state.calls.values()]) {
            await this.endCall(call);
        }

        const now = Date.now();
        const seconds = Math.floor((now / 1000) % 60);
        const minutes = Math.floor((now / 60000) % 60);
        const salt = `${minutes.toString().padStart(2, '0')}${seconds.toString().padStart(2, '0')}`;

        const call = {
            id: `${this.key}_${salt}`,
            startDate: now,
            reconnectDate: 0,
            signalingChannel: null,
            peerConnection: null,
            localStream: null,
            remoteStream: null
        };

        this.state.calls.set(call.id, call);

        try {
            this.trace(`Call started`);
            this.setStatus('connecting');
            this.extendCallTimeout(call, WebRTCsession.SIGNALING_TIMEOUT_MS);

            if (this.microphone) {
                // Acquire microphone for two-way audio
                if (window.isSecureContext && navigator.mediaDevices) {
                    try {
                        call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                        this.trace('Microphone access granted.');
                    }
                    catch (err) {
                        this.trace(`Failed to access microphone: ${err.name}:${err.message}`);
                    }
                }
                else {
                    this.trace(`Microphone not available in this context.`);
                }
            }

            await this.openSignalingChannel(call);
            if (!call.signalingChannel) {
                throw new Error('Signaling channel is not available.');
            }

            this.createPeerConnection(call);

            if (config.video === true) {
                call.peerConnection.addTransceiver('video', { direction: 'recvonly' });
                this.trace('Configured video transceiver: receive-only.');
            }

            if (call.localStream && call.localStream.getAudioTracks().length > 0) {
                call.localStream.getTracks().forEach(track => {
                    call.peerConnection.addTrack(track, call.localStream);
                });

                if (config.audio === false) {
                    call.peerConnection.getTransceivers().forEach(transceiver => {
                        if (transceiver.sender.track?.kind === 'audio') {
                            transceiver.direction = 'sendonly';
                            this.trace('Configured audio transceiver: send-only.');
                        }
                    });
                }
                else {
                    this.trace('Configured two-way audio.');
                }
            }
            else if (config.audio === true) {
                call.peerConnection.addTransceiver('audio', { direction: 'recvonly' });
                this.trace('Configured audio transceiver: receive-only.');
            }
        } catch (err) {
            this.lastError = `Error establishing WebRTC call. ${err.name}: ${err.message}`;
            this.trace(this.lastError);
            this.setStatus('error');

            await this.endCall(call);
            return null;
        }

        (async () => {
            try {
                const offer = await call.peerConnection.createOffer({
                    voiceActivityDetection: false,
                    iceRestart: true
                });
                this.trace('Offer created.');
        
                await call.peerConnection.setLocalDescription(offer);
                this.trace('Local description set successfully.');
        
                if (call.signalingChannel) {
                    this.extendCallTimeout(call, WebRTCsession.SIGNALING_TIMEOUT_MS);
                    await call.signalingChannel.sendOffer(offer);
                    this.trace('Offer sent via signaling channel.');
                } 
                else {
                    throw new Error('Signaling channel is not available.');
                }
            } catch (err) {
                this.lastError = `Error negotiating WebRTC call. ${err.name}: ${err.message}`;
                this.trace(this.lastError);
                this.setStatus('error');

                await this.endCall(call);
            }
        })();

        return call;
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
        this.state.calls.delete(call.id);

        if (this.state.calls.size === 0 || this.state.activeCall === call) {
            this.state.activeCall = null;
        }

        this.trace('Call ended');
        this.timeoutCall(call);
        this.eventTarget.dispatchEvent(new CustomEvent('connected', { detail: {connected: false} }));        
    }

    createPeerConnection(call) { 
        const { config } = this; 

        if (call.peerConnection) {
            this.trace("Existing peer connection detected. Closing first.");
            try { call.peerConnection.close(); } catch { }
            call.peerConnection = null;
        }

        const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
        const pc = new RTCPeerConnection(rtcConfig);

        pc.oniceconnectionstatechange = () => {
            this.trace(`ICE state: ${pc.iceConnectionState}`);

            const iceState = pc.iceConnectionState;
            switch (iceState) {
                case "completed":
                case "connected":
                    this.setStatus('connected');
                    this.eventTarget.dispatchEvent(new CustomEvent('connected', { detail: {connected: true} }));
                    this.extendCallTimeout(call, WebRTCsession.RENDERING_TIMEOUT_MS);
                    break;

                case "failed":
                case "closed":
                case "disconnected":
                    this.restartCall(call);
                    break;
            }
        };

        pc.onicecandidate = ev => {
            if (!call.signalingChannel?.isOpen) {
                this.trace(`Signaling channel closed, cannot send ICE '${ev?.candidate?.candidate}'`);
                return;
            }
            if (ev.candidate) {
                this.extendCallTimeout(call, WebRTCsession.SIGNALING_TIMEOUT_MS);
                call.signalingChannel.sendCandidate(ev.candidate);
                this.trace(`Sent ICE candidate '${ev.candidate.candidate}'`);
            } else {
                call.signalingChannel.sendCandidate();
                this.trace('Completed gathering ICE candidates');
            }
        };

        pc.ontrack = ev => {
            const track = ev.track;
            this.trace(`Received ${track.kind} track ${track.id}`);

            if (!call.remoteStream) {
                call.remoteStream = new MediaStream();
            }
            
            if (track.kind === 'audio' && config.audio === false) return;
            if (track.kind === 'video' && config.video === false) return;

            if (!call.remoteStream.getTracks().some(t => t.id === track.id)) {
                
                call.remoteStream.addTrack(ev.track);
                this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: call.remoteStream } }));
            }
        };

        pc.onremovestream = (ev) => {
            this.trace('Remote stream removed');
            call.remoteStream = null;
            this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: call.remoteStream } }));
        };

        call.peerConnection = pc;
    }

    async openSignalingChannel(call) {
        const { config } = this; 

        let url;
        let signalingChannel = null;

        this.trace(`Opening ${config.url_type} signaling channel`);

        if (config.url_type === 'go2rtc') {
            if (config.url) {
                let params = (new URL(config.url)).searchParams;
                if (params.has('src'))
                    url = `ws${config.url.substr(4).replace(/\/$/, '')}/api/ws?src=${params.get('src')}`;
                else
                    url = `ws${config.url.substr(4).replace(/\/$/, '')}/api/ws?src=${config.entity}`;
                signalingChannel = new Go2RtcSignalingChannel(url);
            }
        }
        else if (config.url_type === 'webrtc-babycam') {
            // custom-component proxy
            url = '/api/webrtc/ws?';
            if (config.url)
                url += '&url=' + encodeURIComponent(config.url);
            if (config.entity)
                url += '&entity=' + encodeURIComponent(config.entity);
            const signature = await this.hass.callWS({
                type: 'auth/sign_path',
                path: url
            });
            if (signature?.path) {
                url = `ws${location.origin.substring(4)}${signature.path}`;
                signalingChannel = new Go2RtcSignalingChannel(url);
            }
        }
        else if (config.url_type === 'webrtc-camera') {
            const data = await this.hass.callWS({
                type: 'auth/sign_path',
                path: '/api/webrtc/ws'
            });
            if (data?.path) {
                url = 'ws' + this.hass.hassUrl(data.path).substring(4);
                if (config.url)
                    url += '&url=' + encodeURIComponent(config.url);
                if (config.entity)
                    url += '&entity=' + encodeURIComponent(config.entity);
                signalingChannel = new Go2RtcSignalingChannel(url);
            }
        }
        else if (config.url_type === 'whep') {
            if (config.url) {
                url = config.url;
                if (!url.includes('/whep'))
                    url += '/' + config.entity + '/whep';
            }
            signalingChannel = new WhepSignalingChannel(url, WebRTCsession.SIGNALING_TIMEOUT_MS);
        }
        else if (config.url_type === 'rtsptoweb') {
            url = config.url;
            signalingChannel = new RTSPtoWebSignalingChannel(url, WebRTCsession.SIGNALING_TIMEOUT_MS);
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
                }
            };

            signalingChannel.onerror = (err) => {
                this.trace(`Signaling error: ${err.message}`);
                this.lastError = err.message;
                this.trace(this.lastError);
                this.setStatus('error');
            };

            signalingChannel.ontrace = (message) => {
                this.trace(`${message}`);
            };

            await signalingChannel.open(WebRTCsession.SIGNALING_TIMEOUT_MS);
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

        const { config } = this; 

        try {
            let url = null;
            if (config.entity && this.hass?.states && this.hass?.connected) {
                const entity = this.hass.states[config.entity];
                url = entity?.attributes?.entity_picture;
            }

            if (!url && config.image_url) {
                url = config.image_url;
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
                }, WebRTCsession.IMAGE_FETCH_TIMEOUT_MS);

                const response = await fetch(url, {
                    signal: abort.signal,
                    cache: "no-store"
                });

                if (response?.ok) {
                    clearTimeout(this.fetchImageTimeoutId);
                    await this.setImage(await response.blob());
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

    async setImage(blob) {
        this.stats.imageBytesReceived += blob.size;

        const previousImage = this.state.image;
        const image = {
            blob: blob,
            size: blob.size,
            hash: await this.hashBlob(blob),
            timestamp: Date.now()
        };
        this.state.image = image;
        this.eventTarget.dispatchEvent(new CustomEvent('image', { detail: { image: image } }));

        if (previousImage) {
            this.trace(`Image updated after ${image.timestamp - previousImage.timestamp}ms`);
        }
        else {
            this.trace(`Image updated`);
        }
    }

    async hashBlob(blob) {
        const buffer = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
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

        this.rendered = false;
        this.playingWaitStartDate = null;
        this.isVisibleInViewport = false;

        this._cardConfig = null;
        this._cardMedia = null;
        this._cardSession = null;
        
        this.resizeObserver = null;
        this.intersectionObserver = null;
        this.intersectionObserverCallback = this.intersectionObserverCallback.bind(this);
        this.documentVisibility = this.documentVisibility.bind(this);
        this.documentVisibilityListener = false;
        this.sessionEvent = this.sessionEvent.bind(this); 
        this.mediaEvent = this.mediaEvent.bind(this); 

        this.playTimeoutId = undefined;
        this.imageRefreshTimeoutId = undefined;
    }

    get config() {
        return this._cardConfig;
    }

    get media() {
        return this._cardMedia;
    }

    get session() {
        return this._cardSession;
    }

    get header() {
        const header = this.shadowRoot.querySelector('.header');
        return header?.innerHTML ?? '';
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

        const { session } = this;
        if (show) {            
            log.classList.remove('hidden');

            if (session && session.tracing !== true)
                session.tracing = true;
        }
        else {
            log.classList.add('hidden');
        }
    }

    async setControlsVisibility(show) {
        // todo: remove defunct method setControlsVisibility

        const timeout = 3000;
        const { media } = this;
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

    renderContainer(muted, image_expiry) {

        this.shadowRoot.innerHTML = `
        <style> 
            :host {
                --image-blur-duration: ${image_expiry / 1000}s;
            }
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
            video[playing="audiovideo"], video[playing="video"], video[playing="paused"] {
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
            @keyframes blurAfterDuration {
                0% {
                    filter: none;
                    opacity: 1;
                }
                99% {
                    filter: none;
                    opacity: 1;
                }
                100% {
                    filter: blur(5px);
                    opacity: 0.5;
                }
            }
            .image {
                display: none;
                width: 100%;
                height: 100%;
                -webkit-touch-callout: none;
                z-index: 1;
            }
            .image[size][timestamp] {
                display: block;
                opacity: 1;
                animation: blurAfterDuration var(--image-blur-duration) forwards;
            }
            .image[size]:not([timestamp]) {
                display: block;
                filter: blur(5px) !important;
                opacity: 0.5 !important;
                animation: none;
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

        const container = this.shadowRoot.querySelector('.media-container');
        this._cardMedia = this.createMedia(muted);
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
                    --ptz-button-opacity: 0.6;
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

    renderShortcuts(shortcuts) {
        if (!shortcuts) return;
        
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

        const icons = shortcuts.map((value, index) =>
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

    static globalInit() {
        if (WebRTCbabycam.initialStaticSetupComplete)
            return;

        const handleKeyUp = (ev) => {
            const unmute = "KeyT";
            const debug = "KeyD";
            const stats = "KeyS";

            if (!ev.shiftKey) return;

            switch (ev.code) {
                case unmute:
                    WebRTCsession.toggleGlobalMute();
                    break;
                case debug:
                    WebRTCsession.toggleGlobalDebug();
                    break;
                case stats:
                    WebRTCsession.toggleGlobalStats();
                    break;
            }
        };
        document.addEventListener('keyup', handleKeyUp, true);
        document.addEventListener('keydown', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        document.addEventListener('mousedown', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        document.addEventListener('touchstart', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        
        WebRTCbabycam.initialStaticSetupComplete = true;
    }

    renderInteractionEventListeners() {
        const container = this.shadowRoot.querySelector('.media-container');
        const image = this.shadowRoot.querySelector('.image');
        const ptz = this.shadowRoot.querySelector('.ptz');
        const shortcuts = this.shadowRoot.querySelector('.shortcuts');
        const state = this.shadowRoot.querySelector('.state');
        const media = this.media;

        container.addEventListener('mousemove', () => {
            if (media?.controls)
                this.setControlsVisibility(true);
            else
                this.setPTZVisibility(true);
        });

        if (document.fullscreenEnabled) {
            this.onDoubleTap(container, () => this.toggleFullScreen());
            this.onMouseDoubleClick(container, () => this.toggleFullScreen());
        }

        if (this.config.video === true) {
            this.onMouseDownHold(container, () => this.setControlsVisibility(true), 800);
            this.onTouchHold(container, () => this.setControlsVisibility(true), 800);
        }

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

    sessionEvent(ev) {
        switch (ev.type) {
            case 'status':
                this.refreshVolume();
                this.refreshMicrophone();
                this.refreshState();
                break;
            case 'remotestream':
                const remoteStream = this.session?.activeCall?.remoteStream;
                if (remoteStream) {
                    this.loadRemoteStream();
                } else {
                    this.unloadRemoteStream();
                }
                break;
            case 'background':
                if (!ev.detail.background) {
                    this.releaseOtherBackgroundCards();
                }
                this.refreshVolume();
                break;
            case 'heartbeat':
                this.live(ev.detail.live && this.isPlaying);
                this.refreshState();
                this.refreshVolume();
                break;
            case 'microphone':
                this.refreshMicrophone();
                break;
            case 'image':
                this.refreshImage(ev.detail.image);
                break;
            case 'trace':
                this.appendTrace(ev.detail.message);
                break;
            case 'stats':
                break;         
            case 'debug':
                this.setDebugVisibility(ev.detail.debug);
                break;
            case 'mute':
                if (ev.detail.mute) {
                    this.muteMedia();
                } else {
                    this.unmuteMedia();
                }
                break;
            case 'unmuteEnabled':
                if (ev.detail.unmuteEnabled) {
                    if (this.media?.classList.contains('unmute-pending')) {
                        this.unmuteMedia();
                    }
                }
                break;
            case 'connected':
                if (ev.detail.connected) {
                    this.loadRemoteStream();
                } else {
                    this.unloadRemoteStream();
                }
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
        const attribute = 'data-mousedown';
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
        const attribute = 'data-hold';
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
        const attribute = 'data-doubletap';
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
        const attribute = 'data-doubleclick';
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
            element.setAttribute(attribute, timer);
        }, true);
    }

    buttonClick(button) {
        const { session, config } = this;
        
        this.setPTZVisibility(true);
        
        if (button.icon === 'mdi:volume-high'
            || button.icon === 'mdi:volume-off'
            || button.icon === 'mdi:pin'
            || button.icon === 'mdi:pin-off'
            || button.classList.contains('ptz-volume')) {
                this.toggleVolume();
                return;
        }

        if (button.icon === 'mdi:microphone'
            || button.icon === 'mdi:microphone-off'
            || button.classList.contains('ptz-microphone')) {
                if (session) {
                    session.microphone = !this.session.microphone;
                }
                return;
        }

        if (button.icon === 'mdi:pause') {
            this.playMedia();
            return;
        }

        if (button.dataset.index !== undefined) {
            const shortcuts = config.shortcuts.services || config.shortcuts;
            const shortcut = shortcuts[button.dataset.index];
            if (shortcut && shortcut.service) {
                const [domain, service] = shortcut.service.split('.', 2);
                const data = shortcut.service_data || {};
                if (domain && service) {
                    session?.hass?.callService(domain, service, data);
                }
            }
            return;
        }

        const ptzData = config.ptz?.['data_' + button.className];
        if (ptzData) {
            const [domain, service] = config.ptz.service.split('.', 2);
            const data = ptzData;
            if (session && domain && service) {
                session?.hass?.callService(domain, service, data);
                setTimeout(() => { session?.fetchImage(); }, 2000);
            }
            return;
        }
    }

    setStateIcon(icon, show = undefined, title = undefined) {
        const stateIcon = this.shadowRoot.querySelector('.state');
        if (!stateIcon) return;

        const currentTitle = stateIcon.title;
        if (title !== undefined && title != currentTitle) {
            stateIcon.title = title;
            show = true;
        }

        const currentIcon = stateIcon.getAttribute('icon');
        if (icon !== undefined && icon != currentIcon) {
            stateIcon.icon = icon;
            stateIcon.setAttribute('icon', icon);

            if (icon === 'mdi:loading') {
                // Synchronize the spin animation based on current time
                const now = Date.now();
                const elapsed = now % 1000; 
                const negativeDelay = -(elapsed / 1000);
    
                // Apply the negative animation-delay to synchronize
                stateIcon.style.animationDelay = `${negativeDelay}s`;
                stateIcon.style.animationDuration = '1s';
                stateIcon.style.animationTimingFunction = 'linear'; 
                stateIcon.style.animationIterationCount = 'infinite';
            }
        }

        const currentShow = stateIcon.classList.contains('show');
        if (show === true && !currentShow)
            stateIcon.classList.add('show');
        else if (show === false && currentShow)
            stateIcon.classList.remove('show');
    }

    get isPlaying() {
        const media = this.media;
        const playing = media && (media.getAttribute('playing') === 'audiovideo' || media.getAttribute('playing') === 'video' || media.getAttribute('playing') === 'audio');
        return playing;
    }

    get isPlayingVideo() {
        const media = this.media;
        const playing = media && (media.getAttribute('playing') === 'audiovideo' || media.getAttribute('playing') === 'video');
        return playing;
    }
 
    get isPaused() {
        const media = this.media;
        const paused = media && media.getAttribute('playing') === 'paused';
        return paused;
    }

    refreshState(reset = false) {
        const { session, media, config } = this;
        
        const status = session?.status;
        const error = session?.lastError;

        const audioOnly = session?.config.video === false && session?.config.audio !== false;
        const doesntPlay = config.video === false && config.audio === false;
        const showStats = WebRTCsession.globalStats || (config.stats && WebRTCsession.globalStats !== false);

        if (doesntPlay) {
            this.header = showStats ? (session?.state?.statistics ?? "") : "";
            return;
        }

        const playing = this.isPlaying;
        const paused = this.isPaused;

        const waitedTooLong = WebRTCsession.RENDERING_TIMEOUT_MS;
        let icon = undefined;
        let show = undefined;
        let title = undefined;

        if (reset) {
            this.playingWaitStartDate = Date.now();
            this.setStateIcon(undefined, false, undefined);
            setTimeout(() => this.refreshState(), waitedTooLong);
            return;
        }

        switch (status) {
            case undefined:
            case null:
                this.setStateIcon("mdi:heart-broken", true);
                return;  

            case 'terminated':
                this.setStateIcon("mdi:emoticon-dead", true);
                return;  

            case 'error':
                icon = "mdi:alert-circle";
                show = true;
                title = error;
                // fall-through

            case 'disconnected':
                if (!this.playingWaitStartDate) {
                    this.playingWaitStartDate = Date.now(); 
                }
                // fall-through

            case 'connecting':
                icon = audioOnly ? "mdi:volume-mute" : "mdi:loading";
                show = show || (Date.now() >= this.playingWaitStartDate + waitedTooLong);
                this.setStateIcon(icon, show, title);
                return;

            case 'connected':
                break;
        }

        if (paused) {
            icon = "mdi:pause";
            show = true;
        }
        else if (playing) {
            
            const stable = Number(media.getAttribute('playing-started') ?? 0) + WebRTCsession.SESSION_TERMINATION_DELAY_MS;
            if (Date.now() > stable) {
                icon = null;
            }
            show = false;

            this.playingWaitStartDate = null;
            this.header = showStats ? (session?.state?.statistics ?? "") : "";
                        
            if (session.background && !config.background) {
                icon = "mdi:pin";
                show = true;
            }
            else if (media.muted && config.muted === false) {
                icon = "mdi:volume-mute";
                show = true;
            }
            else if (!media.muted && config.muted === true) {
                icon = "mdi:volume-high";
                show = true;
            }
        }

        this.setStateIcon(icon, show, title);
    }

    async refreshImage(data) {
        const image = this.shadowRoot.querySelector('.image');
        if (!image || !data) return;

        const lastHash = image.getAttribute('hash');
        const lastTimestamp = image.getAttribute('timestamp');
        if (lastTimestamp === data.timestamp) return;
        if (lastHash && lastHash === data.hash) return;

        const lastSize = image.getAttribute('size');
        if (lastSize) {
            try { URL.revokeObjectURL(image.src); } catch { }
        }
        image.setAttribute('size', data.size);
        
        const expiry = (data.timestamp ?? 0) + this.config.image_expiry;
        if (Date.now() > expiry) {
            image.removeAttribute('timestamp');
        }
        else {
            image.setAttribute('timestamp', data.timestamp);
            const animation = image.getAnimations()[0];
            animation?.cancel();
            animation?.play();
        }
        
        if (data.hash) {
            image.setAttribute('hash', data.hash);
        }

        const objUrl = URL.createObjectURL(data.blob);
        image.src = objUrl;

        clearTimeout(this.imageRefreshTimeoutId);
        this.imageRefreshTimeoutId = setTimeout(() => {
            try { URL.revokeObjectURL(objUrl); } catch { }
        }, this.config.image_expiry);
    }
    
    refreshVolume() {
        const volume = this.shadowRoot.querySelector('.volume');
        if (!volume) return;
    
        const { session, config, media } = this;
        const streaming = session?.isStreaming;
        const audio = session?.isStreamingAudio;
        const audioOnly = config.video === false && config.audio !== false;

        let icon = null; 

        if (!media || !session || !streaming) {
            // No icon to display without an active stream 
            icon = null; 
        }
        else if (session.background) {
            // Background mode enabled
            icon = 'mdi:pin';
        }
        else if (config.audio === false || (streaming && !audio)) {
            // No audio stream

            if (config.background || config.allow_background) {
                // Background mode can be enabled
                icon = 'mdi:pin-off';  
            }
        }
        else if (audioOnly) {
            // Audio only media
            
            if (media.muted || !audio)   {
                // Audio muted or not streaming
                icon = 'mdi:volume-off';
            } else {
                // Unmuted audio
                icon = 'mdi:volume-high';
            }
        }
        else if (streaming) {
            // Video stream with audio

            if (media.muted) {
                icon = 'mdi:volume-off';
            } else {
                icon = 'mdi:volume-high';
            }
        }
    
        if (icon && volume.parentNode.classList.contains('hidden')) {
            volume.parentNode.classList.remove('hidden');
        } else if (!icon && !volume.parentNode.classList.contains('hidden')) {
            volume.parentNode.classList.add('hidden');
        }
    
        if (volume.icon !== icon) {
            volume.icon = icon;
        }
    }
    
    refreshMicrophone() {
        const mic = this.shadowRoot.querySelector('.microphone');
        if (!mic) return;

        let icon = null;
        if (this.session?.microphone) {
            icon = 'mdi:microphone';
        } else {
            icon = 'mdi:microphone-off';
        }

        if (mic.icon != icon) {
            mic.icon = icon;
        }
    }

    trace(text, o) {
        const session = this.session;
        if (session?.tracing === false)
            return;

        text = `${this.instanceId} ${text}`;
        if (session)  {
            session.trace(text, o);
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
        // todo: improve tracing enablement
        if (this.session?.tracing === false) return;

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

        const { session, config } = this;

        if (!document.fullscreenElement) {
            this.requestFullscreen();
            if (config.fullscreen === 'video' && session?.config.video === false && config.video === false) {
                session.config.video = true;
                session.restartCall();
            }
        } else {
            document.exitFullscreen();
            if (config.fullscreen === 'video' && session?.config.video === true && config.video === false) {
                session.config.video = false;
                session.restartCall();
            }
        }
    }

    getCardSize() {
        return 5;
    }

    setConfig(config) { 

        if (!('RTCPeerConnection' in window) && (config.video !== false || config.audio !== false)) {
            throw new Error("Browser does not support WebRTC");
        }
        if (!config.url || !config.entity) {
            throw new Error("Missing `url` or `entity`");
        }
        if (config.ptz && !config.ptz.service) {
            throw new Error("Missing `service` for `ptz`");
        }
      

        const defaultConfig = {
            "entity": null,
            "url": null,
            "video": true,
            "audio": true,
            "muted": true,
            "debug": false,
            "stats": false,
            "microphone": false,
            "background": false,
            "fullscreen": null,
            "image_url": null,
            "image_interval": WebRTCsession.IMAGE_FETCH_INTERVAL_MS,
            "image_expiry": WebRTCsession.IMAGE_FETCH_INTERVAL_MS * WebRTCsession.IMAGE_EXPIRY_RETRIES,
            "allow_background": false,
            "allow_mute": true,
            "allow_pause": false,
            "fps": null,
            "ptz": null,
            "style": null,
            "shortcuts": null,
            "url_type": "webrtc-babycam"
          };

        const mergedConfig = Object.assign({}, defaultConfig, config); 

        mergedConfig.image_expiry = Math.max(33, mergedConfig.image_expiry);
        if (mergedConfig.image_interval != 0){
            mergedConfig.image_interval = Math.max(33, mergedConfig.image_interval);
        }

        if (this._cardConfig) {
            this._cardConfig = mergedConfig;
            this.connectedCallback();
            return;
        }
        this._cardConfig = mergedConfig;
    }

    set hass(hass) {
        const session = this.session;
        if (session) session.hass = hass;
    }

    releaseOtherBackgroundCards()
    {
        [...this.session.state.cards].forEach(otherCard => {
            if (otherCard !== this && otherCard.isVisibleInViewport === false) {
                otherCard.applyVisibility(false, false);
            }
        });
    }

    applyVisibility(visible, allow_background = undefined) {

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
                    media.addEventListener(event, this.mediaEvent);
                });
                this.mediaEventHandlersRegistered = true;
            }

            if (!this.session) {
                const configClone = JSON.parse(JSON.stringify(this._cardConfig));
                this._cardSession = WebRTCsession.getInstance(configClone);
            }

            const session = this.session;
            session.attachCard(this, this.sessionEvent);

            if (session.background && this.config.muted !== true)
                this.unmuteMedia();
    
            this.loadRemoteStream();
            this.live(this.isPlaying);
            this.refreshVolume();
            this.refreshState(true);
            this.refreshMicrophone();
            this.refreshImage(session.state.image);

        }
        else if (allow_background && this.session?.background)
        {
            this.releaseOtherBackgroundCards();
        }
        else {

            if (this.mediaEventHandlersRegistered) {
                mediaEventTypes.forEach(event => {
                    media.removeEventListener(event, this.mediaEvent);
                });
                this.mediaEventHandlersRegistered = false;
            }

            this.session?.detachCard(this, this.sessionEvent);
            this._cardSession = null;

            this.setControlsVisibility(false);
            this.setPTZVisibility(false);
            this.unloadRemoteStream();
        }
    }
   
    isElementActuallyVisible(element) {
        if (!element.isConnected) {
            return false; 
        }
    
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false; 
        }
    
        const rect = element.getBoundingClientRect();
    
        const pointsToCheck = [
            { x: rect.left, y: rect.top },
            { x: rect.right, y: rect.top },
            { x: rect.left, y: rect.bottom },
            { x: rect.right, y: rect.bottom },
        ];
    
        // Check if any corner is visible
        for (const point of pointsToCheck) {
            if (
                point.x >= 0 &&
                point.y >= 0 &&
                point.x <= (window.innerWidth || document.documentElement.clientWidth) &&
                point.y <= (window.innerHeight || document.documentElement.clientHeight)
            ) {
                const elementAtPoint = document.elementFromPoint(point.x, point.y);
                if (elementAtPoint === element || element.contains(elementAtPoint)) {
                    return true; 
                }
            }
        }
    
        return false;
    }
    
    documentVisibility() {
        if (document.hidden) {
            this.isVisibleInViewport = false;
        }
        else {
            this.intersectionObserver?.disconnect();
            this.intersectionObserver = new IntersectionObserver(this.intersectionObserverCallback, { threshold: 0 });
            this.intersectionObserver.observe(this); 

            this.isVisibleInViewport = this.isElementActuallyVisible(this);
        }
        this.applyVisibility(this.isVisibleInViewport, this.session?.background);
    }

    intersectionObserverCallback(entries) {
        const isIntersecting = entries[entries.length - 1].isIntersecting;
        if (this.isVisibleInViewport !== isIntersecting) {
            this.isVisibleInViewport = isIntersecting
            if (document.fullscreenElement) return;

            this.applyVisibility(this.isVisibleInViewport, this.session?.background);
        }
    };

    setupVisibilityAndResizeHandlers() {

        if (!this.intersectionObserver) {
            this.intersectionObserver = new IntersectionObserver(this.intersectionObserverCallback, { threshold: 0 });
            this.intersectionObserver.observe(this); 
        }

        if (!this.resizeObserver) {
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
        }

        if (this.documentVisibilityListener) return;
        document.addEventListener("visibilitychange", this.documentVisibility);
        this.documentVisibilityListener = true;
    }

    removeVisibilityAndResizeHandlers() {

        this.intersectionObserver?.disconnect();
        this.intersectionObserver = null;

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        if (!this.documentVisibilityListener) return;
        document.removeEventListener("visibilitychange", this.documentVisibility);
        this.documentVisibilityListener = false; 
    }

    /** 
    * Render new card (destructive) 
    */
    render() {

        this.rendered = false;

        if (this.shadowRoot) {
            while (this.shadowRoot.firstChild) {
                this.shadowRoot.removeChild(this.shadowRoot.firstChild);
            }
        } 
        else {
            this.attachShadow({ mode: 'open' });
        }
        
        const { session, config } = this;
    
        const hasMove = config.ptz?.data_right;
        const hasZoom = config.ptz?.data_zoom_in;
        const hasHome = config.ptz?.data_home;
        const hasVol = config.audio === true;
        const hasMic = config.microphone || config.allow_microphone;
        const shortcuts = config.shortcuts?.services || config.shortcuts;
        const userCardStyle = config.style;
        
        const background = config.background || session?.background;
        const muted = config.audio === false || config.muted === true || (background === true && config.muted === false)

        if (!this.rendered) {
            this.renderContainer(muted, config.image_expiry);
            this.renderPTZ(hasMove, hasZoom, hasHome, hasVol, hasMic);
            this.renderShortcuts(shortcuts);
            this.renderStyle(userCardStyle);
            this.renderInteractionEventListeners();
            this.rendered = true;
        }
    }

    connectedCallback() {
        WebRTCbabycam.globalInit();

        if (this.session?.state?.cards?.has(this)) {
            // card running in the background
            this.setupVisibilityAndResizeHandlers();
            return;
        }
        
        this.render();
        this.setupVisibilityAndResizeHandlers();

        setTimeout(() => {
            this.setControlsVisibility(false);
            this.setPTZVisibility(false);
            this.setDebugVisibility(WebRTCsession.globalDebug || (this.config.debug && WebRTCsession.globalDebug !== false));
        });
    }

    disconnectedCallback() {
        this.removeVisibilityAndResizeHandlers();
        this.isVisibleInViewport = false;
        this.applyVisibility(false, this.session?.background);
    }

    loadRemoteStream() {
        const { media } = this;
        const remoteStream = this.session?.activeCall?.remoteStream;
        
        if (!remoteStream) return;

        if (media.srcObject === remoteStream) {
            this.trace("Reloading remote media stream");
        }
        else {
            this.trace("Loading remote media stream");
            media.setAttribute('loaded', Date.now());
            media.srcObject = remoteStream;
        }

        if (this.session?.isStreaming && !this.isPlaying) {
            this.playMedia();
        }
    }

    unloadRemoteStream() {
        const { media } = this;
        media.removeAttribute('playing');
        media.removeAttribute('playing-started');
        media.removeAttribute('loaded');
        media.srcObject = null;
        this.trace("Unloaded remote media");
    }

    live(on) {
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
                    height: 10px;
                    min-width: 10px;
                    transform-origin: center; /* Ensures scaling is centered */
                    transform: scale(1); /* Ensures no resizing on zoom */
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
        if (media.muted) {
            if (WebRTCsession.unmuteEnabled) {
                media.classList.remove('unmute-pending');
                media.removeAttribute('muted');
                media.muted = false;
            }
            else {
                // Browser won't play unmuted audio, save intention and unmute when enabled
                media.classList.add('unmute-pending');
            }
        }
        this.refreshState();
        this.refreshVolume();
    }

    muteMedia() {
        const { media } = this;
        media.classList.remove('unmute-pending');
        media.setAttribute('muted', '');
        media.muted = true;
        this.refreshState();
        this.refreshVolume();
    }
            
    toggleVolume() {
        const { session, media, config } = this;
        const allowBackground = session?.background || config.allow_background || config.background;
        const allowMute = config.allow_mute ?? true;

        if (session?.background) {
            this.trace("Exiting background mode");
            session.background = false;

            if (allowMute) {
                this.trace("Muting media");
                this.muteMedia();
            }
            return;
        } // not in background

        if (media.muted) {
            this.trace("Unmuting media");
            this.unmuteMedia();
            return;
        } // unmuted or no audio stream
        
        if (session && allowBackground) {
            this.trace("Enabling background mode");
            session.background = true;
            return;
        } // background mode not allowed

        if (allowMute) {
            this.trace("Muting media");
            this.muteMedia();
        }
    }
    
    pauseMedia() {
        const { media } = this;
        media.classList.add('pause-pending');
        media.pause();
    }

    playMedia(playMuted = undefined) {

        const { session, media } = this;
        
        if (!session || session.isTerminated) {
            return;
        } else if (!media.srcObject) {
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

        if (!mute && !WebRTCsession.unmuteEnabled)
        {
            // avoid browser wrath
            mute = true;
            media.classList.add('unmute-pending');
        }

        if (media.muted != mute)
            media.muted = mute;

        this.trace(`Media play call muted=${media.muted}, unmuteEnabled=${WebRTCsession.unmuteEnabled}`);
       
        media.play()
            .then(_ => {
                media.classList.remove('play-pending');
                if (!media.muted) {
                    media.classList.remove('unmute-pending');
                    WebRTCsession.enableUnmute();
                }
            })
            .catch(err => {
                if (err.name == "NotAllowedError" && !media.muted && playMuted != true) {
                    media.classList.add('play-pending');
                    media.classList.add('unmute-pending');
                    this.trace(`${err.message}`);
                    this.trace('Unmuted play failed');

                    WebRTCsession.enableUnmute(false);
                    
                    // retrying here often fails, so we need to wait for user interaction
                }
                else if (err.name === "AbortError") {
                    this.trace(`Media play aborted: ${err.message}`);
                }
                else {
                    this.trace(`Media play failed: ${err.message}`);
                }
            });
    }

    createMedia(muted) {
        const media = document.createElement('video');
        media.className = 'media';
        media.setAttribute('playsinline', '');
        media.setAttribute('muted', '');
        media.muted = true;
        media.playsinline = true;
        media.controls = false;
        media.autoplay = false;

        if (muted === false) {
            media.classList.add('unmute-pending');
        }

        this.trace(`Created ${media.tagName.toLowerCase()} element`);
        return media;
    }
 
    mediaEvent(ev) {
        
        const { session, media } = this;

        this.trace(`MEDIA ${ev.type}`);
        switch (ev.type) {
            case 'emptied':
                this.live(false);
                media.removeAttribute('playing');
                media.removeAttribute('playing-started');
                media.removeAttribute('loaded');
                break;

            case 'pause':
                this.live(false);
                if (!session || session.isTerminated) return;

                media.setAttribute('playing', 'paused');
                this.refreshState();
                this.refreshVolume();
        
                if (media.classList.contains('pause-pending')) {
                    media.classList.remove('pause-pending');
                    return;
                }

                if (media.classList.contains('play-pending')) {
                    return;
                }
        
                // Override default media element behavior: disable pause for live streams 
                const shouldAllowPause = (media.controls && this.config.allow_pause);
        
                if (!shouldAllowPause) {
                    setTimeout(() => {
                        this.trace('Unpausing video');
                        this.playMedia();
                    });
                }
                break;

            case 'canplay':
                // Autoplay implementation
                this.playMedia();
                break;

            case 'play':
                clearTimeout(this.playTimeoutId);
                this.playTimeoutId = setTimeout(() => {
                    
                    if (!this.isPlaying || !session?.isStreaming)
                        if (!session?.isAnyCardPlaying) {
                            this.unloadRemoteStream();
                            this.trace('Play render timeout');
                            session?.restartCall();
                        }

                }, WebRTCsession.RENDERING_TIMEOUT_MS);

                break;

            case 'playing':
                if (!session || session.isTerminated) return;

                clearTimeout(this.playTimeoutId); 
                media.setAttribute('playing-started', Date.now());

                const audioTracks = media.srcObject?.getAudioTracks()?.length ?? 0;
                const videoTracks = media.srcObject?.getVideoTracks()?.length ?? 0;

                if (!videoTracks) {
                    media.setAttribute('playing', 'audio');
                    this.live(true);
                    this.refreshState(); 
                    this.refreshVolume();
                    return;
                }

                if (audioTracks)
                    media.setAttribute('playing', 'audiovideo');
                else
                    media.setAttribute('playing', 'video');
        
                const w = media.videoWidth || 0;
                const h = media.videoHeight || 0;
                let aspectRatio = 0;
                if (h > 0) {
                    aspectRatio = (w / h).toFixed(4);
                }
                media.setAttribute("aspect-ratio", aspectRatio);
                media.style.setProperty(`--video-aspect-ratio`, `${aspectRatio}`);
        
                this.live(true);
                this.refreshState(); 
                this.refreshVolume();
                break;

            case 'volumechange':

                if (media.muted) { 
                    media.setAttribute('muted', '');
                } else {
                    media.removeAttribute('muted');
                }
                this.refreshVolume();
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
                if (media.controls) {
                    this.setControlsVisibility(true);
                }
                break;

            case 'error':
                this.lastError = media.error.message;
                this.trace(`Media error ${media.error.code}; details: ${media.error.message}`);
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
                    const timeoutError = new Error(`WebSocket connection timed out after ${timeout}ms`);
                    if (this.onerror) {
                        this.onerror(timeoutError);
                    }
                    reject(timeoutError);
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
            this.trace(`Closing WebSocket in state: ${ws.readyState} (${this.getReadyStateText(ws.readyState)})`);
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
        if (!this.isOpen) {
            const errorMsg = `Cannot send candidate because WebSocket is not open. Current readyState: ${this.ws ? this.ws.readyState : 'NO_WEBSOCKET'}`;
            throw new Error(errorMsg);
        }
        const message = {
            type: "webrtc/candidate",
            value: rtcIceCandidate ? rtcIceCandidate.candidate : ""
        };
        try {
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            const sendError = `Failed to send candidate: ${error.message}`; 
            if (this.onerror) {
                this.onerror(new Error(sendError));
            }
            throw error;
        }
    }

    async sendOffer(rtcSessionDescription) {
        if (!this.isOpen) {
            const errorMsg = `Cannot send offer because WebSocket is not open. Current readyState: ${this.ws ? this.ws.readyState : 'NO_WEBSOCKET'}`;
            throw new Error(errorMsg);
        }
        const message = {
            type: 'webrtc/offer',
            value: rtcSessionDescription.sdp
        };
        try {
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            const sendError = `Failed to send offer: ${error.message}`; 
            if (this.onerror) {
                this.onerror(new Error(sendError));
            }
            throw error;
        }
    }

    handleMessage(ev) {
        if (typeof ev.data === "string") {
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (error) {
                const parseError = `Failed to parse incoming message as JSON: ${ev.data}`;
                if (this.onerror) {
                    this.onerror(new Error(parseError));
                }
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
                        this.onerror(new Error(`Server error: ${msg.value}`));
                    }
                    this.close();
                    break;
                default:
                    console.warn(`Unhandled message type: ${msg.type}`);
                    break;
            }
        } else {
            const warning = `Received binary data which is not handled: ${ev.data}`;
            if (this.onerror) {
                this.onerror(new Error(warning));
            }
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
        this.trace(`WebSocket signaling channel opened. URL: ${this.url}`);
    }

    handleError(ev) {
        if (this.websocketTimeoutId) {
            clearTimeout(this.websocketTimeoutId);
            this.websocketTimeoutId = undefined;
        }

        const errorMessage = `WebSocket encountered an error. Current readyState: ${this.ws.readyState} (${this.getReadyStateText(this.ws.readyState)})`;

        if (this._rejectOpen) {
            this._rejectOpen(new Error(errorMessage));
            this._resolveOpen = null;
            this._rejectOpen = null;
        }

        // safari throws error when the server closes unexpectedly 
        // if (this.onerror) {
        //     this.onerror(new Error(errorMessage));
        // }

        this.close();
    }

    handleClose(event) {
        const message = `WebSocket signaling channel closed. Code: ${event.code}, Reason: ${event.reason}, Was Clean: ${event.wasClean}`;
        this.trace(message);
        console.warn(message);

        this.ws = null;
        if (this._rejectOpen) {
            this._rejectOpen(new Error(`WebSocket connection was closed before opening. Code: ${event.code}, Reason: ${event.reason}`));
            this._resolveOpen = null;
            this._rejectOpen = null;
        }
    }

    trace(message) {
        if (this.ontrace)
            this.ontrace(message);
    }

    getReadyStateText(state) {
        switch(state) {
            case WebSocket.CONNECTING:
                return 'CONNECTING';
            case WebSocket.OPEN:
                return 'OPEN';
            case WebSocket.CLOSING:
                return 'CLOSING';
            case WebSocket.CLOSED:
                return 'CLOSED';
            default:
                return 'UNKNOWN';
        }
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
