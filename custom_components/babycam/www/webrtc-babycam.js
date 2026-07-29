// Bump on every release: stale cached card code is the most common cause of "it still
// misbehaves" reports on wall tablets - the console banner, the in-card debug log, and
// the dock tooltip all surface this value so a fresh load is a one-glance check.
const CARD_VERSION = '2026.7.33';

console.info(
    `%c  WebRTC Babycam %c v${CARD_VERSION} `,
    'color: orange; font-weight: bold; background: black',
    'color: white; font-weight: bold; background: dimgray',
);

const noop = () => {};

// Resolve the cross-document root once: reading or writing properties on a cross-origin
// window.top throws SecurityError (HTML spec CrossOriginPropertyFallback), which would
// otherwise break every card operation when HA is embedded in a cross-origin iframe.
const topWindow = (() => {
    try {
        if (window.top && window.top.document) return window.top;
    } catch { }
    return window;
})();

// crypto.randomUUID is secure-context-only (HA commonly runs on plain http); the old
// String(Math.random()).substring(0,6) fallback produced '0.####' - only ~10k distinct
// salts, making call-id collisions routine under unbounded reconnect. getRandomValues is
// NOT secure-context-gated and is the correct insecure-context CSPRNG.
const randomSalt = () => {
    try {
        if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().substring(0, 8);
        if (typeof crypto?.getRandomValues === 'function') {
            return Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch { }
    return String(Math.random()).substring(2, 10);
};

// localStorage can throw on access (storage denied, private mode, sandboxed iframe);
// a throw inside the background getter would prevent card attach entirely.
const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch { } },
    keys(pattern) {
        const result = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && pattern.test(k)) result.push(k);
            }
        } catch { }
        return result;
    }
};

/**
 * WebRTC Babycam Custom Element
 * Provides a lag-free 2-way audio, video, and image camera card.
 */
class WebRTCsession {
    static unmuteEnabled = undefined;
    static globalMute = false;
    static VIDEO_DEFER_BASE_MS = 2000;
    static VIDEO_DEFER_MAX_MS = 30000;
    static VIDEO_FRAME_POLL_INTERVAL_MS = 1000;
    static LIVE_INDICATOR_TIMEOUT_MS = 3000;
    static MEDIA_STALE_GRACE_MS = 2000;
    static TICK_STARVATION_MS = 5000;
    static BACKGROUND_MUTED_GRACE_MS = 60000;

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
    // First-frame reveal gate: how long the video may stay hidden (snapshot
    // showing) after 'playing' while waiting for rVFC proof of a painted
    // frame before revealing regardless.
    static REVEAL_TIMEOUT_MS = 3000;
    static IMAGE_FETCH_TIMEOUT_MS = 10000;
    static IMAGE_FETCH_INTERVAL_MS = 3000;
    static IMAGE_EXPIRY_MS = 30000;
    static IMAGE_EXPIRY_RETRIES = 5;
    static SESSION_TERMINATION_DELAY_MS = WebRTCsession.IMAGE_FETCH_INTERVAL_MS;

    constructor(key, hass, config) {
        if (!config || !config.entity) {
            throw new Error("Entity configuration is required but entity needn't exist");
        }
        
        this.key = key;
        this.hass = hass;
        this.config = config;
        
        this.id = `${this.key}_${randomSalt()}`;

        this.state = {
            cards: new Set(),
            image: null,
            statistics: "",
            status: 'uninitialized',
            calls: new Map(),
            activeCall: null,
            backgroundCard: null
        };

        this.lastError = null;
        this.eventTarget = new EventTarget();
        this.fetchImageInFlight = false;
        this.fetchAbortController = null;
        this.imageLoopTimeoutId = undefined;
        this.watchdogTimeoutId = undefined;
        this.terminationTimeoutId = undefined;
        this.playRunning = false;
        this.imageLoopPhase = undefined;
        this.videoDeferredUntil = 0;
        this.videoPressure = 0;
        this.lastInterestDate = Date.now();
        this.lastTickDate = 0;
        this.parked = null;                  // background park reason: 'muted' | 'expired' | 'user' | null
        // `start: image` opens in the snapshot loop (no WebRTC call) until a
        // gesture goes live; the 'paused' gesture context (tap=go_live,
        // double_tap=fullscreen) then owns the toggling. Initial state only:
        // deliberately NOT part of the session key.
        this.viewerPaused = config.start === 'image';
        this.mutedBackgroundSince = null;
        this.audioOnlyFailures = 0;          // consecutive failed audio-only (video-shed) calls
        this.ownerWindow = window;           // realm liveness check for the shared registry

        this.trace = noop;
        this.resetStats();

        this.determineUnmuteEnabled();
    }

    static get sessions() {
        const root = topWindow;                       // survive same-origin iframes; cross-origin-safe
        const sym = (root.__webrtcSessionsSym ||= Symbol.for('webrtc-babycam:sessions'));
        if (!root[sym]) root[sym] = new Map();
        return root[sym];
    }

    static isSessionAlive(session) {
        // A session created by a destroyed document (same-origin iframe navigated away)
        // schedules timers in a dead realm that never fire; discard it rather than let a
        // card attach to a permanently inert session.
        try { return !!session.ownerWindow?.document?.defaultView; } catch { return false; }
    }

    static requestStreamBudgetRebalance() {}
    static rebalanceStreamBudget() {}

    static key(config) {
        let key = config.entity.replace(/[^a-z0-9A-Z_-]/g, '-');

        if (config.audio === false) key += '-a';
        if (config.video === false) key += '-v';

        // Distinguish sessions that target different sources or capabilities, so cards
        // sharing an entity but differing in url/url_type/image_url/microphone do not
        // collide onto (and silently inherit) the first card's session and config.
        // ice_servers joins the variant ONLY when configured, so existing installs keep
        // their historical keys (and stored background pins) unchanged.
        const variantParts = [
            config.url_type ?? '',
            config.url ?? '',
            config.image_url ?? '',
            config.microphone === true ? 'm' : ''
        ];
        if (config.ice_servers) {
            try { variantParts.push(JSON.stringify(config.ice_servers)); } catch { }
        }
        // Same join-only-when-configured rule as ice_servers: existing installs
        // keep their historical session keys (and stored background pins).
        if (config.image_entity) {
            variantParts.push(config.image_entity);
        }
        const variant = variantParts.join('|');
        let hash = 5381;
        for (let i = 0; i < variant.length; i++) {
            hash = ((hash * 33) ^ variant.charCodeAt(i)) >>> 0;
        }
        key += '-' + hash.toString(36);

        return key;
    }

    static getInstance(config) {
        let hass = WebRTCsession.resolveHass();
        let key = WebRTCsession.key(config);
        let session = WebRTCsession.sessions.get(key);
        if (session && (session.isTerminated || !WebRTCsession.isSessionAlive(session))) {
            WebRTCsession.sessions.delete(key);
            session = null;
        }
        if (!session) {
            session = new WebRTCsession(key, hass, config);
            WebRTCsession.sessions.set(key, session);
            BackgroundManager.getInstance().adoptSession(session);
            console.debug(`****** created session ${session.id} #${WebRTCsession.sessions.size}`);
        }
        return session;
    }

    static resolveHass() {
        try {
            return topWindow.document?.body?.querySelector("home-assistant")?.hass
                ?? document.body.querySelector("home-assistant")?.hass;
        } catch {
            return document.body.querySelector("home-assistant")?.hass;
        }
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
        if (!Number.isFinite(a) || a <= 0) return "0 Bytes";
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
            let transportBytes;
            let inboundBytes = 0;
            result.forEach(report => {
                if (report.type === "transport") {
                    // RTCTransportStats
                    transportBytes = report["bytesReceived"];
                    this.stats.tlsVersion = report["tlsVersion"] || "";
                    this.stats.dtlsCipher = report["dtlsCipher"] || "";
                    this.stats.srtpCipher = report["srtpCipher"] || "";
                }
                else if (report.type === "inbound-rtp") {
                    inboundBytes += report["bytesReceived"] || 0;
                    if ((report.kind || report.mediaType) === 'video') {
                        // RTCInboundRtpStreamStats
                        this.stats.frameWidth = report["frameWidth"] || 0;
                        this.stats.frameHeight = report["frameHeight"] || 0;
                        this.stats.framesDecoded = report["framesDecoded"] || 0;
                        this.stats.framesDropped = report["framesDropped"] || 0;
                        this.stats.totalFreezesDuration = report["totalFreezesDuration"] || 0;
                    }
                }
            });

            // Firefox does not populate transport.bytesReceived (the whole 'transport'
            // report type arrived only in FF 153); fall back to summing inbound-rtp so
            // the stats overlay doesn't report 0 B/s while a stream is playing.
            this.stats.peerBytesReceived = (typeof transportBytes === 'number' && transportBytes > 0)
                ? transportBytes
                : inboundBytes;

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

            if (deltaFrames < 0 || deltaTime <= 0 || deltaBytes < 0) {
                // counters decreased (e.g. framesDecoded/bytesReceived reset on reconnect); rebase
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
        const hasCardPlaying = [...this.state.cards].some(card => card.isPlayingActive === true);
        return hasCardPlaying;
    }

    get isAnyCardPlayingVideo() {
        const hasCardPlayingVideo = [...this.state.cards].some(card => card.isPlayingVideoActive === true);
        return hasCardPlayingVideo;
    }

    get isStatsEnabled() {
        return WebRTCsession.globalStats || [...this.state.cards].some(card => card.config.stats);
    }

    get hasVisibleVideoCards() {
        return [...this.state.cards].some(card => card.isVisibleInViewport && card.config.video !== false);
    }

    get shouldKeepBackgroundAudio() {
        return this.background && this.config.audio !== false && !this.hasVisibleVideoCards;
    }

    get shouldShedBackgroundVideo() {
        // While only the hidden background card holds the stream, negotiating video wastes
        // bandwidth/decode on frames nothing renders. Shed it from the offer unless the
        // config opts out or audio-only offers have repeatedly failed against this source.
        return this.shouldKeepBackgroundAudio
            && this.config.video === true
            && this.config.background_video !== 'keep'
            && this.audioOnlyFailures < 2;
    }

    get isVideoDeferred() {
        return !this.shouldKeepBackgroundAudio && this.config.video !== false && Date.now() < this.videoDeferredUntil;
    }

    get videoDeferRemainingMs() {
        return Math.max(0, this.videoDeferredUntil - Date.now());
    }

    noteInterest() {
        this.lastInterestDate = Date.now();
    }

    /**
     * Viewer-requested image mode (gesture verbs go_image / go_live / toggle_live).
     * Mirrors background parking: the play() tick keeps the image loop running but
     * holds no WebRTC call while paused. Session-scoped by design — cards sharing
     * this session (same key) pause and resume together.
     */
    setViewerPaused(paused) {
        const next = !!paused;
        // This is a never-stop-playing card first: freezing live video to a
        // snapshot is UNSUPPORTED unless the card was configured image-first
        // (start: image). The guard sits here, below every gesture verb and
        // config, so no default, action mapping, or stray tap can stop a
        // live-first stream. Resuming is always allowed.
        if (next && this.config.start !== 'image') {
            this.trace('Viewer pause refused: live-first card (start != image)');
            return;
        }
        if (!!this.viewerPaused === next) return;
        this.viewerPaused = next;
        this.trace(next ? 'Viewer paused (image mode)' : 'Viewer resumed (live)');
        this.noteInterest();
        this.kick();
    }

    relieveVideoPressure(force = false) {
        const next = force ? 0 : Math.max(0, this.videoPressure - 1);
        if (next === this.videoPressure && (!force || this.videoDeferredUntil === 0)) return false;

        this.videoPressure = next;
        if (force || next === 0) {
            this.videoDeferredUntil = 0;
        }
        return true;
    }

    deferVideo(reason = undefined, ms = WebRTCsession.VIDEO_DEFER_BASE_MS) {
        if (this.config.video === false) return 0;
        if (this.shouldKeepBackgroundAudio) {
            this.trace(`Ignoring video defer while preserving background audio${reason ? `: ${reason}` : ''}`);
            return 0;
        }

        const pressure = Math.min(this.videoPressure + 1, 5);

        const delay = Math.max(
            ms,
            Math.min(WebRTCsession.VIDEO_DEFER_MAX_MS, WebRTCsession.VIDEO_DEFER_BASE_MS * (2 ** (pressure - 1)))
        );
        const until = Date.now() + delay;
        if (until <= this.videoDeferredUntil) return delay;

        // Only escalate backoff pressure when this defer actually extends the window, so a
        // burst of media events from a single outage does not saturate the backoff to the cap.
        this.videoPressure = pressure;
        this.videoDeferredUntil = until;
        this.trace(`Video deferred ${delay}ms${reason ? `: ${reason}` : ''}`);

        clearTimeout(this.watchdogTimeoutId);
        this.watchdogTimeoutId = undefined;

        if (this.state.cards.size > 0 && !this.isTerminated) {
            this.play();
        }
        return delay;
    }

    getImageLoopDelay(interval) {
        if (this.imageLoopPhase == null) {
            let hash = 5381;
            for (let i = 0; i < this.key.length; i++) {
                hash = ((hash * 33) ^ this.key.charCodeAt(i)) >>> 0;
            }
            this.imageLoopPhase = hash;
        }

        const phase = this.imageLoopPhase % Math.max(1, interval);
        const delay = interval - ((Date.now() + phase) % interval);
        return Math.max(10, delay || interval);
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

        // image_interval === 0 is a sentinel meaning "polling disabled" for that card.
        // Honor it (instead of clamping 0 up to 10ms, which produced a fetch storm) by
        // returning 0 only when every card disables polling; otherwise use the smallest
        // positive interval.
        const positive = intervals.filter(i => i > 0);
        if (positive.length === 0) {
            return 0;
        }
        return Math.max(10, Math.min(...positive));
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

        const delay = this.getImageLoopDelay(interval);
        this.imageLoopTimeoutId = setTimeout(() => {
            this.imageLoopTimeoutId = undefined;
            this.imageLoop();
        }, delay);

        if (this.isAnyCardPlayingVideo) return;
        this.fetchImage();
    }

    async play(id = undefined) {
        if (id !== this.watchdogTimeoutId) {
            return;
        }
        if (this.playRunning) {
            // A play() tick is already executing (suspended at an await). Don't run a
            // second body concurrently; the in-flight tick will reschedule the loop.
            return;
        }

        let call = null;
        let live = false;
        let videoDeferred = false;

        this.playRunning = true;
        try {

            if (this.isTerminated) return;   // finally still runs and will not reschedule

            const now = Date.now();
            const tickGap = this.lastTickDate ? now - this.lastTickDate : 0;
            this.lastTickDate = now;
            const starved = tickGap > WebRTCsession.TICK_STARVATION_MS;

            call = this.activeCall;
            live = !!(call && this.isStreaming && (this.config.video === false || this.isAnyCardPlaying));
            videoDeferred = this.isVideoDeferred;
            const isStatsEnabled = this.isStatsEnabled;

            if (!id) {
                clearTimeout(this.imageLoopTimeoutId);
                this.imageLoopTimeoutId = undefined;
                this.setStatus('reset');
                this.resetStats();
            }

            this.imageLoop();
            this.evaluateBackground(now);

            if (this.parked || this.viewerPaused) {
                // Parked (background) or viewer-paused (gesture go_image): image loop
                // only, no WebRTC.
                if (call) {
                    this.trace(this.viewerPaused
                        ? 'Viewer paused; stopping call'
                        : `Background parked (${this.parked}); stopping call`);
                    await this.endCall(call);
                    call = null;
                }
            }
            else if (videoDeferred) {
                if (call) {
                    this.trace('Video deferred; falling back to image loop');
                    await this.endCall(call);
                    call = null;
                }
            }
            else if (this.config.video === false && this.config.audio === false) {
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
                // The deadline is wall-clock; when hidden-tab timer throttling, freeze/resume,
                // or bfcache restore starves ticks past the deadline, don't tear down a call
                // whose media demonstrably kept flowing during the gap.
                const recentMedia = [...this.state.cards].some(card =>
                    now - card.lastMediaActivityDate < WebRTCsession.RENDERING_TIMEOUT_MS + tickGap);
                if (starved && this.isStreaming && recentMedia) {
                    this.trace(`Play watchdog starved ${tickGap}ms; extending deadline`);
                    this.extendCallTimeout(call, WebRTCsession.RENDERING_TIMEOUT_MS);
                }
                else {
                    this.trace(`Play watchdog timeout`);
                    if (call.videoShed && !call.everConnected) this.noteAudioOnlyFailure();
                    await this.endCall(call);
                    // Restart in the SAME tick: under intensive throttling (1 tick/min when
                    // hidden with no live track) a next-tick restart doubles every outage.
                    call = await this.startCall();
                    this.state.activeCall = call;
                }
            }

            if (isStatsEnabled) {
                await this.updateStatistics();
            }
            live = !!(call && this.isStreaming && (this.config.video === false || this.isAnyCardPlaying));
            this.eventTarget.dispatchEvent(new CustomEvent('heartbeat', { detail: {live: live} }));

        }
        catch (err) {
            this.lastError = err.message;
            this.trace(`Play ${err.name}: ${err.message}`);
        }
        finally {
            this.playRunning = false;
            if (this.isTerminated && this.state.cards.size === 0) {
                this.watchdogTimeoutId = undefined;
                return;
            }

            const now = Date.now();
            const intervalRemaining = videoDeferred && !call
                ? Math.min(
                    this.videoDeferRemainingMs || this.getImageLoopDelay(Math.max(1000, this.getMinCardImageInterval())),
                    this.getImageLoopDelay(Math.max(1000, this.getMinCardImageInterval()))
                )
                : 1000 - (now % 1000);
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
        clearTimeout(this.imageLoopTimeoutId);
        this.imageLoopTimeoutId = undefined;
        this.timeoutCall(call);

        this.trace('Restarting call');
        this.play();
    }

    /**
     * Forces an immediate watchdog tick (clears any scheduled tick first). Used after
     * suspension/throttling, on visibility changes, and by the background ticker so
     * recovery never waits out a throttled setTimeout.
     */
    kick() {
        if (this.playRunning || this.isTerminated) return;
        clearTimeout(this.watchdogTimeoutId);
        this.watchdogTimeoutId = undefined;
        this.play();
    }

    /**
     * Background fail-safe evaluation, run once per watchdog tick.
     * - Parks a hidden background stream whose audio is autoplay-blocked (muted with no
     *   possible gesture): a stream nobody can hear must not burn bandwidth all night,
     *   but it is parked LOUDLY (dock chip + 'parked' event), never dropped silently.
     * - Applies the optional background_timeout TTL, counted from last user interest.
     */
    evaluateBackground(now) {
        const config = this.config;

        // Parking only ever applies to an UNATTENDED hidden stream. Any visible card -
        // including a visible audio-only card, which shouldKeepBackgroundAudio does not
        // count as a "visible video card" - means an active viewer: never park, and
        // resume anything parked.
        const anyCardVisible = [...this.state.cards].some(card => card.isVisibleInViewport);
        if (!this.shouldKeepBackgroundAudio || this.state.cards.size === 0 || anyCardVisible) {
            this.mutedBackgroundSince = null;
            if (this.parked) this.unpark();
            return;
        }

        const timeoutMinutes = Number(config.background_timeout) || 0;
        if (timeoutMinutes > 0 && !this.parked
            && now - this.lastInterestDate > timeoutMinutes * 60000) {
            this.park('expired');
            return;
        }

        if (!this.isStreamingAudio) {
            this.mutedBackgroundSince = null;
            return;
        }

        const audible = [...this.state.cards].some(card => card.media && !card.media.muted && card.isPlaying);
        if (audible) {
            this.mutedBackgroundSince = null;
            if (this.parked === 'muted') this.unpark();
            return;
        }

        if (WebRTCsession.unmuteEnabled) return; // pending unmute flush will make it audible

        this.mutedBackgroundSince ??= now;
        const configuredGrace = Number(config.background_muted_grace);
        const grace = (Number.isFinite(configuredGrace) && configuredGrace >= 0)
            ? configuredGrace : WebRTCsession.BACKGROUND_MUTED_GRACE_MS;   // 0 = park immediately
        if (config.background_mute_policy !== 'keep' && !this.parked
            && now - this.mutedBackgroundSince >= grace) {
            this.park('muted');
        }
    }

    noteAudioOnlyFailure() {
        this.audioOnlyFailures = Math.min(2, this.audioOnlyFailures + 1);
        if (this.audioOnlyFailures >= 2) {
            this.trace('Audio-only offers failing; keeping video in background calls');
        }
    }

    park(reason) {
        if (this.parked === reason) return;
        this.parked = reason;
        this.trace(`Background parked: ${reason}`);
        this.timeoutCall(this.activeCall);
        this.eventTarget.dispatchEvent(new CustomEvent('parked', { detail: { parked: reason } }));
        this.kick();
    }

    unpark() {
        if (!this.parked) return;
        this.trace(`Background unparked (${this.parked})`);
        this.parked = null;
        this.mutedBackgroundSince = null;
        this.noteInterest();
        this.eventTarget.dispatchEvent(new CustomEvent('parked', { detail: { parked: null } }));
        this.kick();
    }

    /**
     * Designates `card` as the single hidden holder of the background stream.
     * Returns false when another live designee already holds it (the caller then
     * fully detaches), making "which card keeps streaming" deterministic.
     */
    claimBackground(card) {
        if (!this.background) return false;
        const current = this.state.backgroundCard;
        if (current && current !== card && this.state.cards.has(current)) return false;
        this.state.backgroundCard = card;
        BackgroundManager.getInstance().broadcastClaim(this.key);
        return true;
    }

    releaseBackground(card = undefined) {
        const current = this.state.backgroundCard;
        if (!current || (card && card !== current)) return;
        this.state.backgroundCard = null;
        if (!current.isVisibleInViewport && this.state.cards.has(current)) {
            current.applyVisibility(false, false);
        }
    }

    async terminate() {
        clearTimeout(this.watchdogTimeoutId);
        clearTimeout(this.imageLoopTimeoutId);
        clearTimeout(this.terminationTimeoutId);

        this.watchdogTimeoutId = undefined;
        this.imageLoopTimeoutId = undefined;
        this.terminationTimeoutId = undefined;
        this.latestCallId = null;

        try { this.fetchAbortController?.abort(); } catch { }

        // Mark terminated BEFORE awaiting teardown so any watchdog tick suspended at an
        // await observes isTerminated and neither reschedules itself nor starts a new call.
        this.setStatus('terminated');

        for (const call of [...this.state.calls.values()]) {
            await this.endCall(call);
        }

        // A suspended play() tick may have re-armed the watchdog while we awaited above.
        clearTimeout(this.watchdogTimeoutId);
        this.watchdogTimeoutId = undefined;

        BackgroundManager.getInstance().releaseLease(this.key);

        // A replacement session may have been created under this key while the teardown
        // awaits above were suspended; never delete the replacement.
        if (WebRTCsession.sessions.get(this.key) === this) {
            WebRTCsession.sessions.delete(this.key);
        }
        WebRTCsession.requestStreamBudgetRebalance();
    }

    attachCard(card, messageHandler) {

        if (this.isTerminated) {
            this.trace(`attachCard ignored: session terminated`);
            return;
        }

        this.trace(`Attaching new card ${card.instanceId} to session`);

        if (this.terminationTimeoutId) {
            clearTimeout(this.terminationTimeoutId);
            this.terminationTimeoutId = null;
            this.trace("Scheduled termination aborted due to session attachment");
        }

        if (this.state.backgroundCard === card) {
            // The hidden designee became visible again: promote it back to a normal card.
            this.state.backgroundCard = null;
        }

        if (this.state.cards.has(card)) {
            this.noteInterest();
            return;
        }

        this.state.cards.add(card);
        this.noteInterest();
        WebRTCsession.rebalanceStreamBudget();

        if (this.background) {
            // One media pipeline per session: a newly attached (visible) card supersedes
            // the hidden designee. Release AFTER adding, so the release path can never
            // drop the card count to zero and trigger the termination grace timer.
            this.releaseBackground();
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
            this.eventTarget.addEventListener(type, messageHandler);
        });

        this.tracing = this.tracing || card.config.debug || WebRTCsession.globalDebug;

        if (card.isVisibleInViewport || this.background) {
            // kick() (not play()) so a stale scheduled tick can't swallow the request and a
            // throttled timer can't delay recovery when a card just became visible.
            this.kick();
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
        if (this.state.backgroundCard === card) {
            this.state.backgroundCard = null;
        }
        WebRTCsession.requestStreamBudgetRebalance();
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
        const now = Date.now();

        const call = this.activeCall;
        const callId = call?.id ?? 'nocall';
        const callStarted = call?.startDate;
        const timestamp = callStarted ? (now - callStarted).toString().padStart(9, '0') : (new Date).getTime();
        
        const text = `${this.id} | ${callId} | ${timestamp}: ${message}`;
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
        // 'terminated' is terminal (REQ-SESS-6). Without this latch, teardown paths that
        // resume AFTER terminate() (endCallFast's 'disconnected', a suspended startCall's
        // 'error') flip isTerminated back to false and resurrect a zombie watchdog chain
        // on a session already removed from the registry.
        if (this.state.status === 'terminated') return;
        this.state.status = value;
        this.trace(`STATE ${value}`);
        this.eventTarget.dispatchEvent(new CustomEvent('status', { detail: { status: value } }));
    }

    get status() {
        return this.state.status;
    }
        
    get background() {
        // A stored runtime preference (set via the UI) is authoritative; otherwise fall
        // back to the config default. Persistence lives in the BackgroundManager registry
        // (in-memory cached — this is a hot path called from media event handlers).
        return BackgroundManager.getInstance().isEnabled(this.key, this.config.background === true);
    }

    set background(value) {
        BackgroundManager.getInstance().setEnabled(this.key, value === true, this.describeForRegistry());
        WebRTCsession.requestStreamBudgetRebalance();
        // The 'background' session event is dispatched by the manager (single dispatch
        // point shared with the dock and cross-tab change paths).
    }

    describeForRegistry() {
        let friendlyName = this.config.entity;
        try {
            friendlyName = this.hass?.states?.[this.config.entity]?.attributes?.friendly_name ?? friendlyName;
        } catch { }
        return {
            entity: this.config.entity,
            friendlyName,
            returnPath: BackgroundManager.getInstance().currentPath(),
            dock: this.config.dock !== false,
            // Full card config: what background resurrection rebuilds a
            // session from after a page (re)load (plain lovelace config,
            // JSON-safe by construction).
            config: { ...this.config }
        };
    }

    get microphone() {
        const stored = safeStorage.get(`webrtc.${this.key}.microphone`);
        if (stored != null) return stored.toLowerCase() === 'true';
        return this.config.microphone === true;
    }

    set microphone(value) {
        safeStorage.set(`webrtc.${this.key}.microphone`, String(value === true));
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

        // iceConnectionState reaches 'connected' before DTLS completes; media cannot flow
        // until connectionState is 'connected', so don't extend liveness deadlines during
        // the ICE-connected/pre-DTLS window.
        if (pc.connectionState !== 'connected') return false;

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
    
    latestCallId = null;

    async startCall() {
        const { config } = this;

        if (this.isTerminated) {
            this.trace('startCall ignored: session terminated');
            return null;
        }

        if (config.video === false && config.audio === false) {
            this.trace('WebRTC disabled');
            return;
        }
        
        for (const call of [...this.state.calls.values()]) {
            await this.endCall(call);
        }

        const now = Date.now();

        const call = {
            id: `call-${randomSalt()}`,
            startDate: now,
            reconnectDate: 0,
            signalingChannel: null,
            clientConfiguration: null,
            peerConnection: null,
            localStream: null,
            remoteStream: null,
            pendingCandidates: [],
            closed: false,
            ended: false,
            videoShed: this.shouldShedBackgroundVideo,
            everConnected: false
        };
        this.state.calls.set(call.id, call);
        this.latestCallId = call.id;

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

            this.createPeer(call);

            if (config.video === true && !call.videoShed) {
                call.peerConnection.addTransceiver('video', { direction: 'recvonly' });
                this.trace('Configured video transceiver: receive-only.');
            }
            else if (call.videoShed) {
                this.trace('Background: video shed from offer (audio-only while hidden).');
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

            // Only genuine establishment failures count against audio-only shedding;
            // deliberate teardowns (park, pagehide, visible-restore restart) must not.
            if (call.videoShed && !call.everConnected) this.noteAudioOnlyFailure();

            await this.endCall(call);
            return null;
        }

        return call;
    }
    
    async endCall(call) {

        if (!call) return;
        call.closed = true;

        // attempt to refresh image before tear down
        try {
            await this.fetchImage();
        } catch { }

        this.endCallFast(call);
    }

    /**
     * Fully synchronous teardown (no awaits): safe to run inside 'pagehide'/'freeze',
     * where an awaited network fetch would never complete and the transports would be
     * left to time out server-side.
     */
    endCallFast(call) {

        if (!call || call.ended) return;
        call.closed = true;
        call.ended = true;

        if (call.disconnectGraceTimeoutId) {
            clearTimeout(call.disconnectGraceTimeoutId);
            call.disconnectGraceTimeoutId = undefined;
        }

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
        WebRTCsession.requestStreamBudgetRebalance();
        this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: null } }));
        this.eventTarget.dispatchEvent(new CustomEvent('connected', { detail: {connected: false} }));
    }

    createPeer(call) { 
        const { config } = this; 

        if (call.peerConnection) {
            this.trace("Existing peer connection detected. Closing first.");
            try { call.peerConnection.close(); } catch { }
            call.peerConnection = null;
        }

        const isStale = () => call.closed || call.id !== this.latestCallId || !this.state.calls.has(call.id);

        // Precedence: explicit config.ice_servers always wins ([] disables STUN entirely:
        // host candidates suffice for LAN peers and nothing pings Google). Otherwise use
        // whatever the signaling channel advertised (camera/webrtc/get_client_config:
        // HA-registered STUN/TURN, including HA Cloud). The historical Google-STUN
        // default remains the fallback for channels that advertise nothing.
        const advertisedIceServers = call.clientConfiguration?.iceServers;
        const iceServers = Array.isArray(config.ice_servers)
            ? config.ice_servers
            : (Array.isArray(advertisedIceServers) && advertisedIceServers.length
                ? advertisedIceServers
                : [{ urls: 'stun:stun.l.google.com:19302' }]);
        const rtcConfig = { iceServers };
        const pc = new RTCPeerConnection(rtcConfig);

        pc.onnegotiationneeded = async () => {
            if (isStale()) { this.trace('Overlapping session event ignored'); return; }

            this.trace('Negotiation needed');

            if (!call.signalingChannel || !call.signalingChannel.isOpen) {
                this.trace('Signaling channel unavailable for renegotiation; restarting call');
                this.restartCall(call);
                return;
            }

            try {
                // No options: the m-lines are fully defined by the transceivers set up in
                // startCall (including video shedding). voiceActivityDetection was removed
                // from the spec, offerToReceive* are legacy and would re-add a recvonly
                // video m-line a shed call deliberately omitted, and iceRestart is a no-op
                // on a fresh RTCPeerConnection (restarts always recreate the peer).
                const offer = await pc.createOffer();
                if (isStale()) { this.trace('Overlapping session event ignored'); return; }
                this.trace('Offer created.');

                await pc.setLocalDescription(offer);
                if (isStale()) { this.trace('Overlapping session event ignored'); return; }
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
                // A call ended mid-negotiation rejects the suspended awaits; that is
                // teardown, not an error - don't stomp the status or trigger a redundant
                // restart on a deliberately-closed call.
                if (isStale()) { this.trace('Overlapping session event ignored'); return; }
                this.lastError = `Error negotiating WebRTC call. ${err.name}: ${err.message}`;
                this.trace(this.lastError);
                this.setStatus('error');
                this.restartCall(call); // Ensure restart on failure
            }
        };
        
        pc.onconnectionstatechange = () => {
            if (isStale()) { this.trace('Overlapping session event ignored'); return; }

            const connectionState = pc.connectionState;
            this.trace(`Connection state: ${connectionState}`);

            switch (connectionState) {
                case "connected":
                    call.everConnected = true;
                    if (call.videoShed) this.audioOnlyFailures = 0;
                    this.setStatus('connected');
                    this.eventTarget.dispatchEvent(new CustomEvent('connected', { detail: {connected: true} }));
                    this.extendCallTimeout(call, WebRTCsession.RENDERING_TIMEOUT_MS);
                    if (call.disconnectGraceTimeoutId) {
                        clearTimeout(call.disconnectGraceTimeoutId);
                        call.disconnectGraceTimeoutId = undefined;
                    }
                    break;
                case "disconnected":
                    // 'disconnected' is frequently transient and self-recovers (brief packet
                    // loss, network roam). Only restart if it has not returned to a connected
                    // state after a grace period, instead of tearing down on every blip.
                    if (!call.disconnectGraceTimeoutId) {
                        call.disconnectGraceTimeoutId = setTimeout(() => {
                            call.disconnectGraceTimeoutId = undefined;
                            if (isStale()) return;
                            // 'completed' exists only in the iceConnectionState enum, never
                            // in connectionState; 'connected' is the sole healthy value here.
                            const state = call.peerConnection?.connectionState;
                            if (state !== 'connected') {
                                this.trace(`Connection still ${state} after grace; restarting`);
                                this.restartCall(call);
                            }
                        }, WebRTCsession.ICE_TIMEOUT_MS);
                    }
                    break;
                case "failed":
                    // 'closed' is unreachable via this event (local close() fires no
                    // connectionstatechange), so only 'failed' needs the restart.
                    this.restartCall(call);
                    break;
            }
        };

        pc.onicecandidate = ev => {
            if (isStale()) { this.trace('Overlapping session event ignored'); return; }

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
            if (isStale()) { this.trace('Overlapping session event ignored'); return; }

            const track = ev.track;
            this.trace(`Received ${track.kind} track ${track.id}`);

            if (!call.remoteStream) {
                call.remoteStream = new MediaStream();
                // Standard replacement for the deprecated pc.onremovestream (kept below as
                // Chromium-only legacy): renegotiated-away tracks are removed, not 'ended'.
                call.remoteStream.addEventListener('removetrack', () => {
                    if (isStale()) return;
                    if (call.remoteStream && call.remoteStream.getTracks().length === 0) {
                        this.trace('Remote stream emptied (removetrack)');
                        call.remoteStream = null;
                        this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: null } }));
                    }
                });
            }

            if (track.kind === 'audio' && config.audio === false) return;
            if (track.kind === 'video' && config.video === false) return;

            if (!call.remoteStream.getTracks().some(t => t.id === track.id)) {
                call.remoteStream.addTrack(ev.track);
                track.addEventListener('ended', () => {
                    if (isStale()) { this.trace('Overlapping session event ignored'); return; }
                    if (!call.remoteStream) return;
                    this.trace(`Remote ${track.kind} track ended ${track.id}`);
                    try { call.remoteStream.removeTrack(track); } catch { }
                    if (call.remoteStream.getTracks().length === 0) {
                        call.remoteStream = null;
                    }
                    this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: call.remoteStream } }));
                });
                this.eventTarget.dispatchEvent(new CustomEvent('remotestream', { detail: { remoteStream: call.remoteStream } }));
            }
        };

        pc.onremovestream = (ev) => {
            if (isStale()) { this.trace('Overlapping session event ignored'); return; }

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

        this.refreshHass();
        this.trace(`Opening ${config.url_type} signaling channel`);

        if (config.url_type === 'hass') {
            // Home Assistant's native camera WebRTC API (built-in go2rtc integration or
            // any registered provider). `url` is intentionally ignored: signaling rides
            // the card's existing authenticated HA connection.
            if (config.entity && this.hass?.connection) {
                url = `camera/webrtc:${config.entity}`;
                signalingChannel = new HomeAssistantSignalingChannel(this.hass, config.entity);
            }
        }
        else if (config.url_type === 'go2rtc') {
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
            // Match the proven legacy WebRTC transport: sign the proxy route, then
            // append the stream name and use the raw go2rtc signaling channel.
            url = '/api/babycam/ws';
            const signature = await this.hass?.callWS?.({
                type: 'auth/sign_path',
                path: url
            });
            if (signature?.path) {
                url = 'ws' + this.hass.hassUrl(signature.path).substring(4);
                if (config.entity)
                    url += '&entity=' + encodeURIComponent(config.entity);
                signalingChannel = new Go2RtcSignalingChannel(url);
            }
            // Integration-level STUN/TURN (config flow): fills the same
            // advertised-configuration slot the hass channel uses, below an
            // explicit per-card ice_servers. Cached per session; a failed
            // fetch stays undefined so the next call retries.
            if (this.integrationClientConfiguration === undefined) {
                try {
                    const cfg = await this.hass?.callWS?.({ type: 'babycam/config' });
                    this.integrationClientConfiguration =
                        Array.isArray(cfg?.ice_servers) && cfg.ice_servers.length
                            ? { iceServers: cfg.ice_servers }
                            : null;
                } catch (err) {
                    this.trace(`babycam/config fetch failed: ${err.message}`);
                }
            }
        }
        else if (config.url_type === 'webrtc-camera') {
            const data = await this.hass?.callWS?.({
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

        const addRemoteCandidate = async (candidate) => {
            if (!candidate) return;
            if (!call.peerConnection?.remoteDescription?.type) {
                call.pendingCandidates.push(candidate);
                this.trace(`Queued ICE candidate '${candidate.candidate}'`);
                return;
            }
            // Plain init dictionaries are the modern form; the RTCIceCandidate wrapper is
            // redundant and turns malformed inits into synchronous constructor throws.
            await call.peerConnection.addIceCandidate(candidate);
        };

        const flushPendingCandidates = async () => {
            if (!call.pendingCandidates?.length || !call.peerConnection?.remoteDescription?.type) return;
            const pendingCandidates = call.pendingCandidates.splice(0);
            for (const pendingCandidate of pendingCandidates) {
                // Per-candidate tolerance, matching the direct oncandidate path: one bad
                // candidate must not drop the rest of the batch or flag the session.
                try {
                    await call.peerConnection.addIceCandidate(pendingCandidate);
                } catch (err) {
                    this.trace(`addIceCandidate error: ${err.name}:${err.message}`);
                }
            }
            this.trace(`Applied ${pendingCandidates.length} queued ICE candidate(s)`);
        };

        try {
            signalingChannel.oncandidate = async (candidate) => {
                const isStale = call.closed || call.id !== this.latestCallId || !this.state.calls.has(call.id);
                if (isStale) { this.trace('Overlapping session event ignored'); return; }

                if (candidate) {
                    this.trace(`Received ICE candidate '${candidate.candidate}'`);
                } else {
                    this.trace('Received end of ICE candidates');
                }
                try {
                    await addRemoteCandidate(candidate);
                }
                catch (err) {
                    this.trace(`addIceCandidate error: ${err.name}:${err.message}`);
                }
            };

            signalingChannel.onanswer = async (answer) => {
                const isStale = call.closed || call.id !== this.latestCallId || !this.state.calls.has(call.id);
                if (isStale) { this.trace('Overlapping session event ignored'); return; }

                this.trace("Received answer");

                try {
                    // The RTCSessionDescription wrapper constructor is deprecated;
                    // setRemoteDescription accepts the {type, sdp} init directly.
                    await call.peerConnection.setRemoteDescription(answer);
                    this.trace(`Remote description set`);
                    await flushPendingCandidates();
                } catch (err) {
                    this.lastError = err.message;
                    this.trace(this.lastError);
                    this.setStatus('error');
                }
            };

            signalingChannel.onerror = (err) => {
                const isStale = call.closed || call.id !== this.latestCallId || !this.state.calls.has(call.id);
                if (isStale) { this.trace('Overlapping session event ignored'); return; }

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
                // RTCConfiguration the server advertised during open (hass channel only);
                // createPeer runs after this and prefers it over the Google-STUN default.
                call.clientConfiguration = signalingChannel.clientConfiguration
                    ?? this.integrationClientConfiguration
                    ?? null;
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

    refreshHass() {
        // Detached background cards stop receiving hass updates from Lovelace, so rotated
        // entity_picture access tokens and signed-path calls would silently start failing.
        // The root <home-assistant> element's hass is always fresh; a stale snapshot's
        // .connected never turns false, so re-resolve unconditionally.
        const fresh = WebRTCsession.resolveHass();
        if (fresh && fresh !== this.hass) this.hass = fresh;
    }

    async fetchImage(maximumCacheAge = 300) {
        if (this.fetchImageInFlight) return;
        if (maximumCacheAge > (Date.now() - this.state.image?.timestamp)) return;

        const { config } = this;

        this.refreshHass();

        try {
            let url = null;
            if (config.entity && this.hass?.states && this.hass?.connected) {
                const entity = this.hass.states[config.entity];
                url = entity?.attributes?.entity_picture;
            }

            // Poster from a DIFFERENT HA entity than the stream source — for
            // setups where `entity` is a go2rtc stream name with no HA entity
            // behind it (e.g. camera.doorbell_sub), so entity_picture above
            // resolves nothing and the card would sit black until WebRTC.
            if (!url && config.image_entity && this.hass?.states && this.hass?.connected) {
                const imageEntity = this.hass.states[config.image_entity];
                url = imageEntity?.attributes?.entity_picture;
            }

            if (!url && config.image_url) {
                url = config.image_url;
            }

            if (!url) {
                this.trace(`Fetch image unable to define URL`);
                return;
            }

            // Per-invocation abort timer: a shared timeout-id field lets an interleaved
            // teardown clear a newer fetch's timer and release the latch mid-flight.
            this.fetchImageInFlight = true;
            const abort = new AbortController();
            this.fetchAbortController = abort;
            const timerId = setTimeout(() => abort.abort(), WebRTCsession.IMAGE_FETCH_TIMEOUT_MS);

            try {
                const response = await fetch(url, {
                    signal: abort.signal,
                    cache: "no-store"
                });

                if (response?.ok) {
                    await this.setImage(await response.blob());
                }
                else if (response) {
                    // Surface auth expiry etc. instead of silently retrying forever; cancel
                    // the unconsumed body so the connection isn't held until GC.
                    try { await response.body?.cancel(); } catch { }
                    this.trace(`Fetch image HTTP ${response.status}`);
                    if (response.status === 401 || response.status === 403) {
                        this.lastError = `Image fetch unauthorized (HTTP ${response.status})`;
                    }
                }
            }
            finally {
                clearTimeout(timerId);
                if (this.fetchAbortController === abort) this.fetchAbortController = null;
                this.fetchImageInFlight = false;
            }
        }
        catch (err) {
            this.fetchImageInFlight = false;
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

        this.instanceId = `${randomSalt()}-${WebRTCbabycam.instanceCount}`;

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
        this.fullscreenChanged = this.fullscreenChanged.bind(this);
        this.documentVisibilityListener = false;
        this._pendingVisibility = null;
        this.connectTimeoutId = undefined;
        this._pendingDetachId = undefined;
        this.ptzHideTimeoutId = undefined;

        // Interaction (hold/tap) machinery: a global generation bounds every hold-repeat
        // loop (bumped on render/disconnect so no loop survives its DOM), and a per-element
        // expiring timestamp replaces the old add/remove click-suppressor dance.
        this._interactionGen = 0;
        this._holdSuppressUntil = new WeakMap();
        this._holdGuarded = new WeakSet();
        this._lastHoldFireDate = 0;
        this.sessionEvent = this.sessionEvent.bind(this); 
        this.mediaEvent = this.mediaEvent.bind(this); 

        this.playPromise = null;
        this.playGen = 0; 
        this.playTimeoutId = undefined;
        this.imageRefreshTimeoutId = undefined;
        this.refreshStateTimeoutId = undefined;
        this.mediaStaleTimeoutId = undefined;
        this.videoFrameCallbackId = undefined;
        this.videoFramePollTimeoutId = undefined;
        this.liveFadeTimeoutId = undefined;
        this.staleDebounceTimeoutId = undefined;
        this.lastMediaActivityDate = 0;
        this.lastActivitySample = null;
        this._fullscreenVideoOverride = false;
        this._fullscreenResumedLive = false;
        this.lastError = null;
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
        const log = this.shadowRoot?.querySelector('.log');
        if (!log) return;

        const { session } = this;
        if (show) {
            log.classList.remove('hidden');
            // Interactive while visible so it can scroll on touch; taps still
            // bubble to the card (a scroll drag raises pointercancel, so the
            // gesture engine ignores it).
            log.classList.add('pointerevents');

            if (!this._versionLogged) {
                this._versionLogged = true;
                this.appendTrace(`webrtc-babycam v${CARD_VERSION}`);
            }

            if (session && session.tracing !== true)
                session.tracing = true;
        }
        else {
            log.classList.add('hidden');
            log.classList.remove('pointerevents');
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
        const ptz = this.shadowRoot?.querySelector('.ptz');
        if (!ptz) return;

        // Timer handle lives in an instance field; the attribute is a pure boolean CSS
        // marker. HTML only guarantees timer-id uniqueness among PENDING timers, so a
        // stale id round-tripped through the DOM may cancel an unrelated later timer.
        clearTimeout(this.ptzHideTimeoutId);
        this.ptzHideTimeoutId = undefined;

        if (show) {
            ptz.setAttribute('show', '');
            this.ptzHideTimeoutId = setTimeout(() => {
                this.ptzHideTimeoutId = undefined;
                this.setPTZVisibility(false);
            }, timeout);
        }
        else {
            ptz.removeAttribute('show');
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
                isolation: isolate;
            }
            .media-container {
                background: var(--primary-background-color);
                /* No double-tap-zoom on the gesture surface (iOS Safari would
                   consume double-taps and delay taps); scrolling still works. */
                touch-action: manipulation;
            }
            /* In native fullscreen the card owns ALL touch gestures: without
               touch-action:none the browser claims drags for scrolling and
               pointercancel eats the swipe-to-close before pointerup can see
               its delta. The remote overlay sets the same thing inline.
               (Separate rules: an unrecognized selector would invalidate a
               combined list on the engine that needs the other one.) */
            :host(:fullscreen) .media-container {
                touch-action: none;
                overscroll-behavior: none;
            }
            :host(:-webkit-full-screen) .media-container {
                touch-action: none;
                overscroll-behavior: none;
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
                transition: filter 300ms linear, opacity 300ms linear;
            }
            video[playing="audiovideo"], video[playing="video"], video[playing="paused"] {
                visibility: visible;
                z-index: 2;
            }
            video[stale] {
                filter: blur(3px);
                opacity: 0.5;
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
                90% {
                    filter: none;
                    opacity: 1;
                }
                100% {
                    filter: blur(3px);
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
                filter: blur(3px) !important;
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
                transition: opacity 300ms linear, visibility 0s linear 300ms;
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
                transition: opacity 300ms linear, visibility 0s linear 0s !important;
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
                /* Drags scroll the log natively (vertical only); taps still
                   bubble to the card's gesture engine. Don't chain scrolls
                   to the dashboard behind the overlay. */
                touch-action: pan-y;
                overscroll-behavior: contain;
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

    renderAspectRatio(aspectRatio) {
        if (!aspectRatio) return;
        const card = this.shadowRoot.querySelector('.card');
        if (!card) return;

        // Accept "16/9" | "16 / 9" | "16:9" | a number; restrict to safe chars before injecting.
        const ar = String(aspectRatio).replace(':', '/').trim();
        if (!/^[\d.\s/]+$/.test(ar)) return;

        // Force a fixed card aspect ratio, fitting the width and cropping the height symmetrically
        // from the center. Uses the CSS `aspect-ratio` property (height derived from width) with
        // `height: auto` so the ratio governs instead of the base `ha-card { height: 100% }`.
        // NOTE: deliberately NOT the padding-bottom-% technique — padding is an animatable length,
        // so when it resolves it animates ("slides in from the top") under any ancestor that
        // transitions padding/all. `height: auto` isn't transitionable, so this never slides.
        // Injected before the user `style:` block so a user can still override (object-position etc).
        card.insertAdjacentHTML('beforebegin', `
        <style>
            ha-card {
                aspect-ratio: ${ar};
                height: auto !important;
                min-height: 0;
            }
            video, .image {
                position: absolute !important;
                inset: 0 !important;
                width: 100% !important;
                height: 100% !important;
                margin: 0 !important;
                object-fit: cover;
                object-position: center;
            }
        </style>
        `);
    }

    // Native element fullscreen is a stage like the overlay: frame the media
    // per `fit` (default both = contain), overriding tile presentation such as
    // renderAspectRatio's cover-crop. Two separate prefix rules — a combined
    // selector list would be invalidated by the unrecognized one.
    renderFullscreenFit(fit) {
        const card = this.shadowRoot.querySelector('.card');
        if (!card) return;
        const rules = WebRTCbabycam.fitRules(String(fit ?? 'both').toLowerCase());
        card.insertAdjacentHTML('beforebegin', `
        <style>
            :host(:fullscreen) video, :host(:fullscreen) .image {${rules}}
            :host(:fullscreen) ha-card, :host(:fullscreen) .media-container { overflow: hidden !important; }
            :host(:-webkit-full-screen) video, :host(:-webkit-full-screen) .image {${rules}}
            :host(:-webkit-full-screen) ha-card, :host(:-webkit-full-screen) .media-container { overflow: hidden !important; }
        </style>
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
            const mute = "KeyT";
            const debug = "KeyD";
            const stats = "KeyS";

            if (!ev.shiftKey) return;

            // Ignore keystrokes typed into editable elements. At document level the event
            // target is retargeted to the outer shadow host, so composedPath()[0] is the
            // only way to see the real origin inside HA's nested shadow DOM.
            const origin = ev.composedPath?.()[0];
            if (origin && (origin.isContentEditable
                || origin.tagName === 'INPUT'
                || origin.tagName === 'TEXTAREA'
                || origin.tagName === 'SELECT')) return;

            switch (ev.code) {
                case mute:
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
        // Activation-granting events only: 'touchstart' grants NO user activation (it
        // arrives at touchend), so unmuting from it gets blocked and latches unmute off.
        document.addEventListener('keydown', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        document.addEventListener('mousedown', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });
        document.addEventListener('touchend', ev => WebRTCsession.enableUnmute(), { once: true, capture: false });

        WebRTCbabycam.initialStaticSetupComplete = true;
    }

    // ------------------------------------------------------------------
    // Gesture actions: configurable tap / double_tap / hold (+ swipe in
    // fullscreen) per context. Contexts: 'image' (snapshot mode), 'live'
    // (streaming), 'fullscreen' (native element fullscreen OR the remote
    // babycam overlay). config.actions.<context>.<gesture> overrides the
    // defaults below; a verb may also be a standard HA action object.
    // ------------------------------------------------------------------
    // Freezing live video is UNSUPPORTED on live-first cards: this is a
    // never-stop-playing card first (the babycam contract), and
    // session.setViewerPaused refuses the pause direction unless the card
    // is configured image-first (start: image). So the 'toggle_live'
    // defaults below only ever stop video on start:image cards — on a
    // live-first card a tap on live video does nothing.
    // Double-tap is fullscreen in EVERY non-fullscreen context (and close
    // within fullscreen) — one muscle memory everywhere.
    static DEFAULT_GESTURES = {
        image:      { tap: 'fetch_image', double_tap: 'fullscreen', hold: 'fullscreen' },
        live:       { tap: 'toggle_live', double_tap: 'fullscreen', hold: 'toggle_mute' },
        // paused = an image-first card parked on its snapshot; 'image' covers
        // cards that are natively snapshot mode (still connecting, video or
        // audio disabled). Default tap REFRESHES the still in both — starting
        // video is an explicit config choice (toggle_live / go_live /
        // fullscreen_live), never a default single tap.
        paused:     { tap: 'fetch_image', double_tap: 'fullscreen', hold: 'fullscreen' },
        fullscreen: { tap: 'close', double_tap: 'close', hold: 'none', swipe: 'close' },
    };

    // Fullscreen/overlay framing rules for a given fit mode. The media keeps
    // its OWN aspect ratio in every mode; `fit` picks the axis it must fill,
    // and overflow on the other axis clips symmetrically from the center.
    // object-fit cannot express per-axis fill, so width/height set element
    // geometry directly. Shared by the remote overlay stage and the
    // :host(:fullscreen) style so both fullscreen paths frame identically.
    static fitRules(fit) {
        if (fit === 'width') {
            return ' position: absolute !important;' +
                ' left: 0 !important; right: 0 !important;' +
                ' top: 50% !important; bottom: auto !important;' +
                ' transform: translateY(-50%) !important;' +
                ' width: 100% !important; height: auto !important;' +
                ' margin: 0 !important;';
        }
        if (fit === 'height') {
            return ' position: absolute !important;' +
                ' top: 0 !important; bottom: 0 !important;' +
                ' left: 50% !important; right: auto !important;' +
                ' transform: translateX(-50%) !important;' +
                ' height: 100% !important; width: auto !important;' +
                ' margin: 0 !important;';
        }
        return ' position: absolute !important; inset: 0 !important;' +
            ' width: 100% !important; height: 100% !important;' +
            ' margin: 0 !important;' +
            ' object-fit: contain !important; object-position: center !important;';
    }

    get isInRemoteOverlay() {
        return !!this.closest?.('#babycam-remote-overlay');
    }

    // Fullscreen ancestry must be computed on the COMPOSED tree:
    // document.fullscreenElement retargets to the outermost shadow HOST
    // (stack-in-card, hui-view, ...) when the fullscreened element lives in
    // nested shadow roots, and Element.contains() does not pierce shadow
    // boundaries — a naive check reports "not fullscreen" for a card
    // fullscreened from inside card stacks, so in-fullscreen taps resolve
    // to the live/paused context (pausing or reopening instead of closing).
    isInFullscreen() {
        const fsEl = document.fullscreenElement ?? document.webkitFullscreenElement;
        if (!fsEl) return false;
        let node = this;
        while (node) {
            if (node === fsEl) return true;
            node = node.parentElement ?? node.getRootNode()?.host ?? null;
        }
        return false;
    }

    gestureContext() {
        if (this.isInRemoteOverlay || this.isInFullscreen())
            return 'fullscreen';
        if (this.session?.viewerPaused) return 'paused';
        return this.session?.isStreaming ? 'live' : 'image';
    }

    gestureFor(gesture, context = undefined) {
        const ctx = context ?? this.gestureContext();
        const conf = this.config?.actions?.[ctx] ?? {};
        const def = WebRTCbabycam.DEFAULT_GESTURES[ctx] ?? {};
        return conf[gesture] !== undefined ? conf[gesture] : def[gesture];
    }

    executeGestureAction(verb) {
        if (!verb || verb === 'none') return;
        if (typeof verb === 'object') { this.executeHaAction(verb); return; }
        const session = this.session;
        switch (verb) {
            case 'fetch_image':
                session?.noteInterest?.();
                session?.fetchImage?.(0);
                break;
            case 'go_live':
                session?.setViewerPaused?.(false);
                this.expireConnectingGrace();
                break;
            case 'go_image':
                session?.setViewerPaused?.(true);
                break;
            case 'toggle_live': {
                // pause if currently streaming, resume if paused/idle
                const pausing = session?.isStreaming === true;
                session?.setViewerPaused?.(pausing);
                if (!pausing) this.expireConnectingGrace();
                break;
            }
            case 'fullscreen':
            case 'toggle_fullscreen':
                this.gestureFullscreen();
                break;
            case 'fullscreen_live':
                this.gestureFullscreenLive();
                break;
            case 'close':
                this.gestureClose();
                break;
            case 'toggle_mute':
                this.toggleVolume?.();
                break;
            case 'controls':
                this.setControlsVisibility?.(true);
                break;
            case 'more_info': {
                const entityId = this.config?.image_entity || this.config?.entity;
                this.dispatchEvent(new CustomEvent('hass-more-info',
                    { bubbles: true, composed: true, detail: { entityId } }));
                break;
            }
            default:
                this.trace?.(`Unknown gesture action: ${verb}`);
        }
    }

    gestureFullscreen() {
        if (this.isInRemoteOverlay) return;   // already effectively fullscreen

        if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
            this.toggleFullScreen();
            return;
        }

        // iOS (no element fullscreen API): ALWAYS the card's own
        // full-viewport overlay, never webkitEnterFullscreen. The native
        // player owns the screen (no Live indicator, no card controls or
        // gestures) and pauses the element on close, flashing the paused
        // state until auto-resume reverses it. Tradeoff accepted 2026-07-29:
        // the native player's AirPlay/PiP affordances are given up for a
        // consistent card experience; the overlay also mounts synchronously
        // inside the gesture and needs no media readiness.
        const session = this.session;
        const resumed = this.config.fullscreen === 'video' && session?.viewerPaused === true;
        if (resumed) {
            session.setViewerPaused(false);
            this.expireConnectingGrace();
        }
        this.trace('fullscreen: full-viewport overlay');
        window.babycamOverlay?.open?.(
            { ...this.config },
            { onclose: resumed ? () => session.setViewerPaused(true) : null }
        );
    }

    // fullscreen_live: fullscreen that always shows live video, regardless of
    // the card-level `fullscreen:` option — the per-gesture counterpart to
    // fullscreen: 'video'. Closing reverses the go-live iff this gesture
    // started it (native exits via fullscreenChanged, overlay via onclose).
    gestureFullscreenLive() {
        if (this.isInRemoteOverlay || this.isInFullscreen()) {
            this.gestureClose();
            return;
        }
        const session = this.session;
        const resumed = session?.viewerPaused === true;
        if (resumed) {
            session.setViewerPaused(false);
            this.expireConnectingGrace();
        }
        if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
            if (resumed) this._fullscreenResumedLive = true;
            this.toggleFullScreen();
            return;
        }
        // no element fullscreen API (iOS WKWebView): the card's own overlay
        // mounts synchronously and needs no media readiness.
        this.trace('fullscreen_live: full-viewport overlay');
        window.babycamOverlay?.open?.(
            { ...this.config },
            { onclose: resumed ? () => session.setViewerPaused(true) : null }
        );
    }

    gestureClose() {
        if (this.isInRemoteOverlay) {
            window.babycamOverlay?.close?.();
            return;
        }
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) this.toggleFullScreen();
    }

    executeHaAction(a) {
        try {
            const act = a?.action;
            if (act === 'perform-action' || act === 'call-service') {
                const svc = a.perform_action || a.service;
                const [domain, service] = svc.split('.');
                this.hass?.callService(domain, service, a.data || a.service_data || {}, a.target);
            }
            else if (act === 'navigate' && a.navigation_path) {
                history.pushState(null, '', a.navigation_path);
                window.dispatchEvent(new CustomEvent('location-changed'));
            }
            else if (act === 'url' && a.url_path) {
                window.open(a.url_path, '_blank');
            }
            else if (act === 'more-info') {
                this.executeGestureAction('more_info');
            }
        }
        catch (err) { this.trace?.(`ha_action failed: ${err.message}`); }
    }

    bindGestures(container) {
        // Discrete UI elements own their own clicks — gestures must not fire
        // when the event originated inside them.
        const ignores = (ev) => {
            const path = ev.composedPath ? ev.composedPath() : [];
            return path.some(n => n instanceof Element && n.classList && (
                n.classList.contains('ptz') || n.classList.contains('shortcuts')
                || n.classList.contains('state')));
        };

        let holdTimer = null;
        let holdFired = false;
        let tapTimer = null;
        let downPoint = null;

        const dispatch = (gesture) => {
            const verb = this.gestureFor(gesture);
            if (verb) this.executeGestureAction(verb);
        };

        // Taps are synthesized from pointer events, NOT the browser 'click':
        // iOS Safari delays click ~350ms (double-tap-zoom disambiguation),
        // swallows the second tap of a double entirely (it zooms instead),
        // and is unreliable for synthesized clicks in shadow DOM — so on
        // WebKit a click-based tap/double-tap engine is dead on arrival.
        // touch-action: manipulation on the container removes the zoom
        // gesture (scrolling still works); pointerup + movement/duration
        // thresholds do the rest identically on every engine. A drag that
        // the browser claims for scrolling raises pointercancel and cleanly
        // becomes no gesture.
        container.addEventListener('pointerdown', (ev) => {
            if (!ev.isPrimary || ignores(ev)) return;
            holdFired = false;
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => { holdFired = true; dispatch('hold'); }, 600);
            downPoint = { x: ev.clientX, y: ev.clientY, t: Date.now() };
        });

        const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
        const cancelGesture = () => { cancelHold(); downPoint = null; };

        container.addEventListener('pointerup', (ev) => {
            cancelHold();
            if (!ev.isPrimary || !downPoint) return;
            const down = downPoint;
            downPoint = null;
            if (ignores(ev)) return;
            if (holdFired) { holdFired = false; return; }
            if (this.media?.controls) return;   // native controls own the surface

            const dx = ev.clientX - down.x;
            const dy = ev.clientY - down.y;
            const dt = Date.now() - down.t;
            const travel = Math.hypot(dx, dy);

            // swipe (ANY direction): fullscreen context only (dashboards need
            // scrolling). NOTE: needs touch-action:none on the surface or the
            // browser claims the drag for scrolling and pointerup never fires
            // with the delta — the remote overlay sets that inline.
            if (this.gestureContext() === 'fullscreen' && dt < 600 && travel > 60) {
                dispatch('swipe');
                return;
            }

            if (travel > 12 || dt >= 600) return;   // drag or slow press, not a tap

            const dbl = this.gestureFor('double_tap');
            if (dbl && dbl !== 'none') {
                // double-tap configured: tap pays the disambiguation delay
                if (tapTimer) {
                    clearTimeout(tapTimer); tapTimer = null;
                    dispatch('double_tap');
                }
                else {
                    tapTimer = setTimeout(() => { tapTimer = null; dispatch('tap'); }, 280);
                }
            }
            else {
                dispatch('tap');
            }
        });
        container.addEventListener('pointercancel', cancelGesture);
        container.addEventListener('pointerleave', cancelHold);

        // mobile long-press must not open the browser context menu / image save
        container.addEventListener('contextmenu', (ev) => { ev.preventDefault(); });
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

        // Configurable gesture engine (tap / double_tap / hold / swipe per
        // context) replaces the old hardcoded bindings: image click->fetch,
        // container double-tap->fullscreen and hold->controls now route
        // through config.actions with back-compatible-ish defaults (see
        // DEFAULT_GESTURES). The iOS video-only fullscreen quirk lives in
        // gestureFullscreen().
        this.bindGestures(container);

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
                    if (!this.isVisibleInViewport && this.session?.state?.backgroundCard === this) {
                        // This card is the hidden designee: unwind itself (detach + unload).
                        // Releasing only OTHER cards left the sole hidden holder streaming
                        // forever after background mode was disabled.
                        this.applyVisibility(false, false);
                    } else {
                        this.session?.releaseBackground();
                    }
                }
                this.refreshVolume();
                this.refreshState();
                break;
            case 'heartbeat':
                // Renew only; never force the dot off here. It fades on its own when renewals
                // stop (stream dead), and is cleared explicitly on stall/pause/stop/unload.
                if (ev.detail.live && this.isPlayingActive) {
                    this.live(true);
                }
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
                } else if (this.media && !this.media.muted) {
                    // Unmute was globally disabled (autoplay blocked on some card). Keep every
                    // card consistent: re-mute and remember the intent to unmute on next gesture,
                    // rather than leaving cards audibly unmuted while the global flag says false.
                    this.muteMedia();
                    this.media.classList.add('unmute-pending');
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

    /**
     * Marks that a hold just fired on `element`, so the click synthesized at release is
     * swallowed. An expiring timestamp + permanent capture guard replaces the old
     * add/remove of a shared stopImmediatePropagation listener, which could not suppress
     * earlier-registered listeners, let one input path deregister the other's pending
     * suppressor, and lingered forever on engines that never deliver the compat click.
     */
    markHoldFired(element) {
        this._holdSuppressUntil.set(element, Date.now() + 700);
        // Card-scoped stamp: the double-click/double-tap detectors live on the CONTAINER
        // while holds also fire on descendants (image, PTZ buttons); capture-phase order
        // means the container detector runs before the descendant's guard can consume.
        this._lastHoldFireDate = Date.now();
    }

    holdJustFired(element, consume = true) {
        const until = this._holdSuppressUntil.get(element) ?? 0;
        if (Date.now() >= until) return false;
        if (consume) this._holdSuppressUntil.set(element, 0);
        return true;
    }

    installHoldClickGuard(element) {
        if (this._holdGuarded.has(element)) return;
        this._holdGuarded.add(element);
        element.addEventListener('click', (ev) => {
            if (this.holdJustFired(element)) {
                ev.stopImmediatePropagation();
                ev.preventDefault();
            }
        }, true);
    }

    onMouseDownHold(element, callback, ms = 500, repeatDelay = undefined) {
        this.installHoldClickGuard(element);
        let pressGen = 0;
        let fired = false;
        // The click to suppress is synthesized at RELEASE, which on a long hold can be
        // well past the fire-time stamp's window - re-stamp at cancel when the hold fired.
        const cancel = () => {
            if (fired) {
                this.markHoldFired(element);
                fired = false;
            }
            pressGen++;
        };

        element.addEventListener('mousedown', ev => {
            if (ev.button != 0) return;
            pressGen++;
            fired = false;
            const myPress = pressGen;
            const myGen = this._interactionGen;
            // Bound the repeat loop by per-press AND per-render generations plus DOM
            // connection - a stale loop suspended in its delay can neither be revived by a
            // re-press nor survive a shadow-DOM rebuild issuing service calls forever.
            const live = () => myPress === pressGen
                && myGen === this._interactionGen
                && element.isConnected;

            setTimeout(async () => {
                if (!live()) return;
                fired = true;
                this.markHoldFired(element);
                if (repeatDelay) {
                    while (live()) {
                        this.markHoldFired(element);
                        callback();
                        await new Promise(resolve => setTimeout(resolve, repeatDelay));
                    }
                }
                else {
                    callback();
                }
            }, ms);
        });

        element.addEventListener('mouseup', cancel);
        element.addEventListener('pointerout', cancel);
    }

    onTouchHold(element, callback, ms = 500, repeatDelay = undefined) {
        this.installHoldClickGuard(element);
        let pressGen = 0;
        let fired = false;
        const cancel = () => {
            if (fired) {
                this.markHoldFired(element);
                fired = false;
            }
            pressGen++;
        };

        element.addEventListener('touchstart', (ev) => {
            pressGen++;
            fired = false;
            if (ev.touches.length > 1) return;
            const myPress = pressGen;
            const myGen = this._interactionGen;
            const live = () => myPress === pressGen
                && myGen === this._interactionGen
                && element.isConnected;

            setTimeout(async () => {
                if (!live()) return;
                fired = true;
                this.markHoldFired(element);
                if (repeatDelay) {
                    while (live()) {
                        this.markHoldFired(element);
                        callback();
                        await new Promise(resolve => setTimeout(resolve, repeatDelay));
                    }
                }
                else {
                    callback();
                }
            }, ms);
        }, { passive: true });

        element.addEventListener('touchend', cancel);
        element.addEventListener('pointerout', cancel);
    }

    onDoubleTap(element, doubleTapCallback, ms = 500) {
        let lastTapDate = 0;
        element.addEventListener('touchend', (ev) => {
            if (ev.touches.length > 0) {
                lastTapDate = 0;
                return;
            }
            // The release of a completed hold - on THIS element or any descendant of this
            // card (image, PTZ) - is not the first tap of a double-tap.
            if (this.holdJustFired(element, false) || Date.now() - this._lastHoldFireDate < 700) {
                lastTapDate = 0;
                return;
            }
            const now = Date.now();
            if (now - lastTapDate < ms) {
                lastTapDate = 0;
                if (doubleTapCallback) {
                    ev.preventDefault();
                    doubleTapCallback();
                }
                return;
            }
            lastTapDate = now;
        }, true);
    }

    onMouseDoubleClick(element, doubleClickCallback, ms = 500) {
        let lastClickDate = 0;
        element.addEventListener('click', ev => {
            if ('pointerType' in ev && ev.pointerType && ev.pointerType !== "mouse") return;
            if (ev.button !== undefined && ev.button !== 0) return;
            // This capture listener registers before the hold guard, so it must consult
            // the hold state itself: hold-then-quick-tap must not trigger fullscreen. The
            // card-scoped stamp also covers holds on DESCENDANTS (image/PTZ), whose own
            // guards run after this container-level capture listener.
            if (this.holdJustFired(element, false) || Date.now() - this._lastHoldFireDate < 700) {
                lastClickDate = 0;
                return;
            }
            const now = Date.now();
            if (now - lastClickDate < ms) {
                lastClickDate = 0;
                if (doubleClickCallback) {
                    this.stopImmediatePropagation(ev);
                    doubleClickCallback();
                }
                return;
            }
            lastClickDate = now;
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
            if (icon == null) {
                stateIcon.icon = '';
                stateIcon.removeAttribute('icon');
            }
            else {
                stateIcon.icon = icon;
                stateIcon.setAttribute('icon', icon);
            }

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
            else {
                stateIcon.style.animationDelay = '';
                stateIcon.style.animationDuration = '';
                stateIcon.style.animationTimingFunction = '';
                stateIcon.style.animationIterationCount = '';
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

    get isMediaStale() {
        const media = this.media;
        return !!(media && media.hasAttribute('stale'));
    }

    get isPlayingActive() {
        return this.isPlaying && !this.isMediaStale;
    }

    get isPlayingVideoActive() {
        return this.isPlayingVideo && !this.isMediaStale;
    }
 
    get isPaused() {
        const media = this.media;
        const paused = media && media.getAttribute('playing') === 'paused';
        return paused;
    }

    clearRefreshStateTimer() {
        clearTimeout(this.refreshStateTimeoutId);
        this.refreshStateTimeoutId = undefined;
    }

    scheduleRefreshState(ms = WebRTCsession.RENDERING_TIMEOUT_MS) {
        this.clearRefreshStateTimer();
        this.refreshStateTimeoutId = setTimeout(() => {
            this.refreshStateTimeoutId = undefined;
            this.refreshState();
        }, Math.max(0, ms));
    }

    // First-frame reveal gate bookkeeping (see the 'playing' handler).
    // Cancelled ONLY at real media teardown (unload / 'emptied') — never from
    // transient stalls: iOS Safari fires 'waiting' after 'playing' and may
    // never fire 'playing' again for a MediaStream, so a stall-path cancel
    // would strand the video hidden forever. reveal() self-guards against
    // firing on torn-down media.
    cancelPendingReveal() {
        const media = this.media;
        if (media && this.revealFrameCallbackId != null && typeof media.cancelVideoFrameCallback === 'function') {
            try { media.cancelVideoFrameCallback(this.revealFrameCallbackId); } catch { }
        }
        this.revealFrameCallbackId = undefined;
        clearTimeout(this.revealTimeoutId);
        this.revealTimeoutId = undefined;
    }

    stopVideoFrameMonitor() {
        const media = this.media;
        if (media && this.videoFrameCallbackId != null && typeof media.cancelVideoFrameCallback === 'function') {
            try { media.cancelVideoFrameCallback(this.videoFrameCallbackId); } catch { }
        }
        this.videoFrameCallbackId = undefined;
        clearTimeout(this.mediaStaleTimeoutId);
        this.mediaStaleTimeoutId = undefined;
        clearTimeout(this.videoFramePollTimeoutId);
        this.videoFramePollTimeoutId = undefined;
        this.lastMediaActivityDate = 0;
        this.lastActivitySample = null; // rebase the stats fallback baseline (frames/samples) on (re)start
    }

    scheduleVideoFrameMonitor(immediate = false) {
        const { media } = this;
        const srcObject = media?.srcObject;
        const hasVideo = !!srcObject?.getVideoTracks?.().length;
        const hasAudio = !!srcObject?.getAudioTracks?.().length;
        if (!media || (!hasVideo && !hasAudio)) {
            return;
        }

        // Self-sustaining poll: re-armed every interval whether or not requestVideoFrameCallback
        // fires, so the monitor can never stall on engines that don't deliver rVFC for a MediaStream.
        if (this.videoFramePollTimeoutId != null) {
            return;
        }

        const delay = immediate ? 0 : Math.min(
            WebRTCsession.VIDEO_FRAME_POLL_INTERVAL_MS,
            Math.max(250, Math.floor(this.config.image_expiry / 4))
        );
        this.videoFramePollTimeoutId = setTimeout(async () => {
            this.videoFramePollTimeoutId = undefined;
            if (!this.isPlaying) return;

            const video = !!media.srcObject?.getVideoTracks?.().length;
            if (video) {
                const rvfcSupported = typeof media.requestVideoFrameCallback === 'function';
                // A still-pending rVFC means it didn't fire last interval — the engine isn't
                // delivering presented-frame callbacks for this MediaStream (iOS Safari + WebRTC).
                const rvfcNotFiring = rvfcSupported && this.videoFrameCallbackId != null;

                // Preferred signal: rVFC fires when a frame is actually PRESENTED — true proof the
                // image isn't frozen, at zero polling cost. This is the indicator's intended driver.
                if (rvfcSupported && this.videoFrameCallbackId == null) {
                    try {
                        this.videoFrameCallbackId = media.requestVideoFrameCallback(() => {
                            this.videoFrameCallbackId = undefined;
                            this.noteMediaActivity();
                        });
                    } catch {
                        this.videoFrameCallbackId = undefined;
                    }
                }

                // Fallback ONLY where rVFC can't deliver: decoded video-frame count advancing.
                // Engines with a working rVFC never reach this, so playback is NEVER slowed.
                if (!rvfcSupported || rvfcNotFiring) {
                    await this.noteMediaActivityFromStats(true);
                }
            }
            else {
                // Audio-only edge case: no rendered frames, so "not frozen" becomes "audio is still
                // flowing" — received samples advancing. Less critical, and there's no image to slow.
                await this.noteMediaActivityFromStats(false);
            }

            this.scheduleVideoFrameMonitor();
        }, delay);
    }

    // Stats-based liveness, used only where the cheap per-frame / timeupdate signals don't fire
    // (notably iOS Safari + WebRTC). video=true → decoded video frames advancing (image not frozen);
    // video=false → received audio samples advancing (audio still flowing).
    async noteMediaActivityFromStats(video) {
        const pc = this.session?.activeCall?.peerConnection;
        if (!pc) return;
        let sample = 0;
        try {
            const stats = await pc.getStats(null);
            stats.forEach(report => {
                if (report.type !== 'inbound-rtp') return;
                // CRITICAL for Safari: it does NOT populate report.kind on inbound-rtp — it uses the
                // legacy 'mediaType', or neither. A `report.kind === 'video'` filter matches ZERO
                // reports on Safari, which is why the dot died there. Select by kind||mediaType, then
                // fall back to the stat shape: only video inbound-rtp carries framesDecoded.
                const kind = report.kind || report.mediaType
                    || (typeof report.framesDecoded === 'number' ? 'video' : 'audio');
                if (video && kind === 'video') {
                    sample += report.framesDecoded || 0;
                }
                else if (!video && kind === 'audio') {
                    // Receipt-based counters only: totalSamplesReceived INCLUDES concealed
                    // samples, which NetEq keeps synthesizing at the sample rate during a
                    // total RTP outage - a dead stream would look alive forever. Prefer
                    // packetsReceived (plateaus on outage, like framesDecoded for video),
                    // and only fall back to concealment-corrected samples.
                    sample += report.packetsReceived
                        ?? report.bytesReceived
                        ?? ((report.totalSamplesReceived != null)
                            ? report.totalSamplesReceived - (report.concealedSamples ?? 0)
                            : 0);
                }
            });
        } catch {
            return;
        }
        const prev = this.lastActivitySample;
        this.lastActivitySample = sample;
        // Renew when the counter advances — and on the FIRST positive sample (a non-zero
        // framesDecoded / samples count already proves media is being produced, so we don't waste a
        // whole poll cycle just establishing a baseline). A counter reset on reconnect (sample < prev)
        // just rebases without a false renewal. A frozen/dead stream stops advancing → dot fades.
        if (sample > 0 && (prev == null || sample > prev)) {
            this.noteMediaActivity();
            if (prev == null) this.trace(`Live via stats fallback (${video ? 'framesDecoded' : 'audio packets'}=${sample})`);
        }
    }

    scheduleMediaStaleCheck() {
        if (this.mediaStaleTimeoutId != null) return;

        const delay = Math.max(0, (this.lastMediaActivityDate + this.config.image_expiry) - Date.now());
        this.mediaStaleTimeoutId = setTimeout(() => {
            this.mediaStaleTimeoutId = undefined;
            const remaining = (this.lastMediaActivityDate + this.config.image_expiry) - Date.now();
            if (remaining > 0) {
                this.scheduleMediaStaleCheck();
                return;
            }
            this.setMediaStale(true);
        }, delay);
    }

    scheduleMediaStale(graceMs = WebRTCsession.MEDIA_STALE_GRACE_MS) {
        if (this.staleDebounceTimeoutId != null) return;
        const { media } = this;
        if (!media || media.hasAttribute('stale')) return;
        this.staleDebounceTimeoutId = setTimeout(() => {
            this.staleDebounceTimeoutId = undefined;
            this.setMediaStale(true, false);
        }, Math.max(0, graceMs));
    }

    setMediaStale(stale = true, deferVideo = stale) {
        const { media, session } = this;
        if (!media) return;

        // Any explicit stale decision (true now, or activity clearing it) supersedes a pending
        // debounce. noteMediaActivity -> setMediaStale(false) is what cancels a transient blur.
        clearTimeout(this.staleDebounceTimeoutId);
        this.staleDebounceTimeoutId = undefined;

        if (stale) {
            clearTimeout(this.mediaStaleTimeoutId);
            this.mediaStaleTimeoutId = undefined;
            if (!media.hasAttribute('stale')) {
                media.setAttribute('stale', '');
            }
            this.live(false);
            this.refreshState();
            if (session?.state?.cards?.has(this) && deferVideo && this.isPlayingVideo) {
                session.deferVideo?.('stale video', WebRTCsession.RENDERING_TIMEOUT_MS);
            }
            if (session?.state?.cards?.has(this) && !session.isAnyCardPlayingVideo) {
                session.fetchImage(0);
            }
            return;
        }

        media.removeAttribute('stale');
    }

    noteMediaActivity(startFrameMonitor = false) {
        const { media } = this;
        if (!media) return;

        this.lastMediaActivityDate = Date.now();
        const wasStale = media.hasAttribute('stale');
        this.setMediaStale(false);
        this.scheduleMediaStaleCheck();

        if (media.srcObject?.getVideoTracks?.().length) {
            this.session?.relieveVideoPressure?.();
        }

        // Renew the live indicator on real media activity (rendered frame / timeupdate). This
        // is the independent confirmation that the stream is producing media — distinct from
        // the watchdog/ICE-state heartbeat — so the dot tracks actual rendering.
        if (this.isPlayingActive) {
            this.live(true);
        }

        if (wasStale) {
            this.refreshState();
        }

        if (!startFrameMonitor) {
            return;
        }

        this.scheduleVideoFrameMonitor(true);
    }

    expireConnectingGrace() {
        // A deliberate go-live is the one moment the viewer EXPECTS progress
        // feedback: backdate the wait window so the connecting spinner fades
        // in immediately instead of after the tardy-connection grace.
        this.playingWaitStartDate = Date.now() - WebRTCsession.RENDERING_TIMEOUT_MS;
        this.refreshState();
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

        const playing = this.isPlayingActive;
        const paused = this.isPaused;

        const waitedTooLong = WebRTCsession.RENDERING_TIMEOUT_MS;
        let icon = undefined;
        let show = undefined;
        let title = undefined;

        // Intentional image modes — the viewer parked on image (viewerPaused)
        // or deferred video with a frame in hand — are not "waiting": the
        // loading spinner means a wanted stream is failing, never a chosen
        // snapshot.
        if (session?.viewerPaused
            || (session?.isVideoDeferred && session?.state?.image && !session?.activeCall)) {
            this.clearRefreshStateTimer();
            this.playingWaitStartDate = null;
            this.header = showStats ? (session?.state?.statistics ?? "") : "";
            this.setStateIcon(null, false, undefined);
            return;
        }

        if (reset) {
            this.playingWaitStartDate = Date.now();
            this.setStateIcon(undefined, false, undefined);
            this.scheduleRefreshState(waitedTooLong);
            return;
        }

        this.clearRefreshStateTimer();

        switch (status) {
            case undefined:
            case null:
                this.setStateIcon("mdi:heart-broken", true);
                return;  

            case 'terminated':
                this.setStateIcon("mdi:emoticon-dead", true);
                return;  

            case 'error':
                // An 'error' here is one failed attempt in the card's unbounded
                // reconnect loop, not a settled failure. Showing mdi:alert-circle
                // immediately (no grace) while 'connecting' hides its spinner
                // until waitedTooLong made the icon STROBE error<->hidden (and
                // swap glyph) on every retry. Fold error into the connecting
                // grace path: a steady loading spinner after the shared clock,
                // with the cause kept in the hover tooltip. Recovery hides it; a
                // persistent failure shows a steady spinner, never a flash.
                title = error;
                // fall-through

            case 'disconnected':
                if (!this.playingWaitStartDate) {
                    this.playingWaitStartDate = Date.now(); 
                }
                // fall-through

            case 'connecting':
                if (!this.playingWaitStartDate) {
                    this.playingWaitStartDate = Date.now();
                }
                // error/disconnected/connecting all share this "still trying"
                // glyph now (steady loading spinner), so the icon never swaps
                // mid-retry; the error text rides the tooltip.
                if (icon === undefined) {
                    icon = audioOnly ? "mdi:volume-mute" : "mdi:loading";
                }
                show = show || (Date.now() >= this.playingWaitStartDate + waitedTooLong);
                if (show !== true) {
                    this.scheduleRefreshState((this.playingWaitStartDate + waitedTooLong) - Date.now());
                }
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
        else {
            if (!this.playingWaitStartDate) {
                this.playingWaitStartDate = Date.now();
            }
            icon = audioOnly ? "mdi:volume-mute" : "mdi:loading";
            show = Date.now() >= this.playingWaitStartDate + waitedTooLong;
            if (show !== true) {
                this.scheduleRefreshState((this.playingWaitStartDate + waitedTooLong) - Date.now());
            }
        }

        this.setStateIcon(icon, show, title);
    }

    async refreshImage(data) {
        const image = this.shadowRoot.querySelector('.image');
        if (!image || !data) return;

        const lastHash = image.getAttribute('hash');
        const lastTimestamp = image.getAttribute('timestamp');
        const sameHash = !!(lastHash && data.hash && lastHash === data.hash);
        // Images currently carry no hash, so fall back to timestamp-only dedup; this skips
        // the redundant revoke/createObjectURL + animation restart on unchanged re-renders.
        if (lastTimestamp === String(data.timestamp) && (sameHash || !data.hash)) return;

        const lastSize = image.getAttribute('size');
        const previousUrl =
            lastSize && image.src?.startsWith('blob:') ? image.src : null;
        image.setAttribute('size', data.size);
        
        const expiry = (data.timestamp ?? 0) + this.config.image_expiry;
        if (Date.now() > expiry) {
            image.removeAttribute('timestamp');
        }
        else {
            image.setAttribute('timestamp', data.timestamp);
            const animation = image.getAnimations?.()[0];
            if (animation) {
                animation.cancel();
                animation.play();
            }
            else {
                image.style.animation = 'none';
                void image.offsetWidth;
                image.style.animation = '';
            }
        }
        
        if (data.hash) {
            image.setAttribute('hash', data.hash);
        }

        const objUrl = URL.createObjectURL(data.blob);
        image.src = objUrl;
        // Revoke the blob displaced on the PREVIOUS refresh, not this one:
        // revoking the current bitmap before its replacement paints blanks
        // the <img> to the container background (a white flash on the
        // video -> image transition), and image.decode() is not a usable
        // wait — WebKit re-rasterizes on decode(), flickering EVERY refresh.
        // By the next refresh the prior swap has long painted, so the
        // grandparent URL is always safe to release; at most two blob URLs
        // are ever held. No timer-based revoke either: when images stop
        // arriving (stream stale), that would blank the URL the <img> is
        // still displaying instead of letting it stay shown (blurred).
        if (this.displacedImageUrl && this.displacedImageUrl !== objUrl) {
            try { URL.revokeObjectURL(this.displacedImageUrl); } catch { }
        }
        this.displacedImageUrl = previousUrl;
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

        text = `${this.instanceId} | ${text}`;
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

        const log = this.shadowRoot?.querySelector('.log');
        if (!log) return;

        const max_entries = 1000;
        const min_entries = 500;

        // Escape before injecting: trace messages embed remote-derived strings (server
        // errors, ICE candidate SDP) that must not be parsed as markup. Also replace ALL
        // newlines (String.replace with a string target only hits the first occurrence).
        const escaped = `${this.instanceId} | ${message}`
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        log.insertAdjacentHTML('beforeend', `${escaped}<br>`);
        if (log.childNodes.length > max_entries) {
            while (log.childNodes.length > min_entries) {
                log.removeChild(log.firstChild);
            }
        }
        log.scrollTop = log.scrollHeight;
    }

    toggleFullScreen() {
        if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) return;

        const { session, config } = this;

        // Mutating the shared session.config.video affects every card on the session, so only
        // apply the fullscreen video upgrade when this card is the sole consumer, and restore
        // exactly what we changed (tracked per card) rather than hard-setting false on exit.
        const fullscreenVideo = config.fullscreen === 'video' && config.video === false && !!session;
        const soleCard = !!session && session.state.cards.size <= 1;

        // Prefix-aware state test: on webkit-prefixed-only engines (iPadOS/macOS Safari
        // <= 16.3) document.fullscreenElement is always undefined, which would make the
        // exit branch unreachable - enter would work but exit never.
        const fullscreenElement = document.fullscreenElement ?? document.webkitFullscreenElement;

        if (!fullscreenElement) {
            // requestFullscreen returns a promise with several spec-defined rejection
            // paths (permissions policy, no transient activation); never leave it
            // unhandled. Rejection is a real path, not just theory: gesture verbs
            // dispatched from the tap/hold timers run OUTSIDE the user-activation
            // window, and WebKit rejects activation-less requests that Chrome's 5 s
            // transient-activation grace still allows. Fall back to the card's own
            // full-viewport overlay, which needs no activation.
            try {
                const request = this.requestFullscreen ? this.requestFullscreen() : this.webkitRequestFullscreen?.();
                if (request?.catch) {
                    request.catch(err => {
                        this.trace(`fullscreen: ${err.message}; falling back to overlay`);
                        this.openOverlayFallback();
                    });
                }
            } catch (err) {
                this.trace(`fullscreen: ${err.message}; falling back to overlay`);
                this.openOverlayFallback();
            }
            if (fullscreenVideo && soleCard && session.config.video === false) {
                this._fullscreenVideoOverride = true;
                session.config.video = true;
                session.restartCall();
            }
            // fullscreen: 'video' on an image-first card: entering fullscreen
            // IS the go-live gesture — fullscreen always shows live video.
            // The snapshot is restored on exit (fullscreenChanged, so Esc and
            // system exits count) only when this transition started the video.
            if (config.fullscreen === 'video' && session?.viewerPaused) {
                this._fullscreenResumedLive = true;
                session.setViewerPaused(false);
                this.expireConnectingGrace();
            }
        } else {
            try {
                const exit = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.();
                exit?.catch?.(err => this.trace(`fullscreen: ${err.message}`));
            } catch (err) {
                this.trace(`fullscreen: ${err.message}`);
            }
            if (fullscreenVideo && this._fullscreenVideoOverride && session.config.video === true) {
                this._fullscreenVideoOverride = false;
                session.config.video = false;
                session.restartCall();
            }
        }
    }

    // Native fullscreen was refused (no transient activation, permissions
    // policy, ...). No fullscreenchange will ever fire, so consume the state
    // the enter path staged — the resume flag and the session video override —
    // and hand the job to the overlay, whose onclose re-parks if entering
    // fullscreen is what started the video.
    openOverlayFallback() {
        const session = this.session;
        const resumed = this._fullscreenResumedLive === true;
        this._fullscreenResumedLive = false;
        if (this._fullscreenVideoOverride && session?.config.video === true) {
            this._fullscreenVideoOverride = false;
            session.config.video = false;
            session.restartCall();
        }
        window.babycamOverlay?.open?.(
            { ...this.config },
            { onclose: resumed && session ? () => session.setViewerPaused(true) : null }
        );
    }

    getCardSize() {
        return 5;
    }

    setConfig(config) { 
        if (!('RTCPeerConnection' in window) && (config.video !== false || config.audio !== false)) {
            throw new Error("Browser does not support WebRTC");
        }
        if (!config.entity) {
            throw new Error("Missing `entity`");
        }
        // Home Assistant-backed transports need no per-card URL. Direct transports
        // remain available for advanced/standalone configurations.
        const urlType = config.url_type ?? 'webrtc-babycam';
        if (!['hass', 'webrtc-babycam'].includes(urlType) && !config.url) {
            throw new Error(`Missing \`url\` (required for url_type '${urlType}')`);
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
            "image_entity": null,
            "actions": null,
            "image_interval": WebRTCsession.IMAGE_FETCH_INTERVAL_MS,
            "image_expiry": WebRTCsession.IMAGE_FETCH_INTERVAL_MS * WebRTCsession.IMAGE_EXPIRY_RETRIES,
            "allow_background": false,
            "background_muted_grace": WebRTCsession.BACKGROUND_MUTED_GRACE_MS,
            "background_mute_policy": "park",
            "background_video": "shed",
            "background_timeout": 0,
            "dock": true,
            "allow_mute": true,
            "allow_pause": false,
            "allow_microphone": false,
            "fps": null,
            "ice_servers": null,
            "ptz": null,
            "style": null,
            "shortcuts": null,
            "aspect_ratio": null,
            "fit": null,
            "url_type": "webrtc-babycam"
          };

        const mergedConfig = Object.assign({}, defaultConfig, config); 

        mergedConfig.image_expiry = Math.max(33, mergedConfig.image_expiry);
        if (mergedConfig.image_interval != 0){
            mergedConfig.image_interval = Math.max(33, mergedConfig.image_interval);
        }

        if (mergedConfig.fit != null) {
            // Fullscreen/overlay framing: both | width | height (see fitRules).
            const fit = String(mergedConfig.fit).trim().toLowerCase();
            mergedConfig.fit = ['both', 'width', 'height'].includes(fit) ? fit : null;
        }
        if (mergedConfig.aspect_ratio != null) {
            // Accept "16/9", "16 / 9", "16:9", or a number; normalize to a CSS aspect-ratio value.
            mergedConfig.aspect_ratio = String(mergedConfig.aspect_ratio).trim().replace(':', '/');
        }

        // Normalize/validate ice_servers before it is stored: key() forks the session on
        // any truthy value while createPeer honors only arrays, so a silently-ignored
        // malformed value would both discard the user's TURN/STUN config AND split the
        // session. A single mapping is a forgivable YAML shape; anything else throws.
        if (mergedConfig.ice_servers != null && !Array.isArray(mergedConfig.ice_servers)) {
            if (typeof mergedConfig.ice_servers === 'object') {
                mergedConfig.ice_servers = [mergedConfig.ice_servers];
            } else {
                throw new Error("`ice_servers` must be an array of RTCIceServer objects (or [])");
            }
        }

        if (this._cardConfig) {
            // Reconfiguration of an already-initialized card. Detach from the current session
            // FIRST so connectedCallback()'s "already attached" early-return doesn't skip
            // applying the new config. The new config may change the entity/url/capabilities
            // (and therefore the session key), so a clean detach + re-render + reattach is
            // required to bind to the correct session instead of silently keeping the old one.
            const wasConnected = this.isConnected;
            const wasHiddenDesignee = this.session?.state?.backgroundCard === this;
            this.applyVisibility(false, false); // detaches card and clears _cardSession
            this._cardConfig = mergedConfig;
            // Force a fresh IntersectionObserver on the re-run: an already-observed,
            // still-intersecting target generates no further records, so without a new
            // observe() a visible reconfigured card would stay detached (black) forever.
            this.isVisibleInViewport = false;
            this._pendingVisibility = null;
            this.intersectionObserver?.disconnect();
            this.intersectionObserver = null;
            if (wasConnected) {
                this.connectedCallback();
            }
            // A hidden background designee must survive reconfiguration: the detach above
            // dropped the session's only card (starting the 3s termination grace), and
            // neither the fresh IntersectionObserver (still not intersecting) nor the
            // proactive connect check (this.session is null now) can re-attach a
            // non-visible card. Re-arm under the (possibly re-keyed) session: the visible
            // pass re-registers media handlers and reloads the stream, the immediate
            // hidden pass hands the card back to designee state; attachCard cancels a
            // pending same-key termination.
            if (wasHiddenDesignee && !this.isElementActuallyVisible(this)) {
                const configClone = JSON.parse(JSON.stringify(this._cardConfig));
                const session = WebRTCsession.getInstance(configClone);
                if (session.background) {
                    this._cardSession = session;
                    this.applyVisibility(true);
                    this.applyVisibility(false, true);
                }
            }
            return;
        }
        this._cardConfig = mergedConfig;

        if (this.isConnected) {
            // reuse the same init path as normal attach
            this.connectedCallback();
        }
    }

    set hass(hass) {
        const session = this.session;
        if (session) session.hass = hass;
    }

    // Attach a never-visible card as its session's background designee — the
    // resurrection entry point (BackgroundManager.resurrectSuspendedSessions).
    // A from-birth-hidden card can't attach on its own: the
    // IntersectionObserver reports not-intersecting and the proactive
    // connect check requires this.session, which doesn't exist yet. Reuse
    // setConfig's hidden-designee re-arm dance: the visible pass registers
    // media handlers and loads the stream, the immediate hidden pass hands
    // the card to designee state.
    attachAsBackgroundDesignee() {
        if (!this._cardConfig || this.session) return false;
        const configClone = JSON.parse(JSON.stringify(this._cardConfig));
        const session = WebRTCsession.getInstance(configClone);
        if (!session.background) return false;
        this._cardSession = session;
        this.applyVisibility(true);
        this.applyVisibility(false, true);
        return true;
    }

    releaseOtherBackgroundCards()
    {
        // Compat shim: the session now tracks a single designated background card.
        this.session?.releaseBackground();
    }

    applyVisibility(visible, allow_background = undefined) {

        const mediaEventTypes = [
            'emptied',
            'pause',
            'canplay',
            'play',
            'playing',
            'timeupdate',
            'waiting',
            'stalled',
            'loadedmetadata',
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

            if (!this.session || this.session.isTerminated) {
                const configClone = JSON.parse(JSON.stringify(this._cardConfig));
                this._cardSession = WebRTCsession.getInstance(configClone);
            }

            const session = this.session;
            session.attachCard(this, this.sessionEvent);
            session.relieveVideoPressure?.(true);
            session.unpark?.();

            if (session.activeCall) {
                // A visible card is proof of interest: after suspension/throttling the
                // wall-clock deadline may already be stale — extend rather than letting
                // the next tick tear down a healthy call.
                session.extendCallTimeout(session.activeCall, WebRTCsession.RENDERING_TIMEOUT_MS);

                if (session.activeCall.videoShed && this.config.video === true) {
                    // Background call was negotiated audio-only; restore video for viewing.
                    session.restartCall();
                }
            }

            if (session.background && this.config.muted !== true)
                this.unmuteMedia();

            this.loadRemoteStream();
            if (this.isPlaying) {
                // isPlaying (not isPlayingVideo): an audio-only card returning from the
                // hidden-designee state keeps playing the same srcObject, so no new
                // 'playing' event will ever restart the liveness monitor - this is the
                // only unhide-time restart, and it must cover audio too.
                this.noteMediaActivity(true);
            }
            this.live(this.isPlayingActive);
            this.refreshVolume();
            this.refreshState(true);
            this.refreshMicrophone();
            this.refreshImage(session.state.image);

            BackgroundManager.getInstance().noteCardVisible(session, this);
        }
        else if (allow_background && this.session?.background && this.session.claimBackground(this))
        {
            this.trace(`Holding background stream as designated card`);
            this.stopVideoFrameMonitor?.();
            this.setMediaStale?.(false, false);

            const session = this.session;
            if (session.shouldShedBackgroundVideo && session.activeCall && !session.activeCall.videoShed) {
                // Renegotiate audio-only: no card renders video while hidden.
                session.restartCall();
            }
            BackgroundManager.getInstance().noteCardHidden(session, this);
        }
        else {
            this.trace(`Detaching card from session`);
            const session = this.session;

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

            if (session) BackgroundManager.getInstance().noteCardHidden(session, this);
        }
    }
   
    isElementActuallyVisible(element) {
        if (!element.isConnected) {
            return false;
        }

        // A page can be loaded already-hidden (opened in a background tab); geometry is
        // still computed there, so gate on actual page visibility first.
        if (document.visibilityState !== 'visible') {
            return false;
        }

        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return false;
        }

        const pointsToCheck = [
            { x: rect.left + 1, y: rect.top + 1 },
            { x: rect.right - 1, y: rect.top + 1 },
            { x: rect.left + 1, y: rect.bottom - 1 },
            { x: rect.right - 1, y: rect.bottom - 1 },
            { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 },
        ];

        // Check if any probe point hits this card
        for (const point of pointsToCheck) {
            if (
                point.x >= 0 &&
                point.y >= 0 &&
                point.x <= (window.innerWidth || document.documentElement.clientWidth) &&
                point.y <= (window.innerHeight || document.documentElement.clientHeight)
            ) {
                // document.elementFromPoint retargets hits inside shadow trees to the
                // outermost shadow host, so inside HA's nested shadow DOM it can never
                // return this card directly. Descend open shadow roots to reach the real
                // hit, then test containment along the composed (shadow-including) tree.
                let hit = document.elementFromPoint(point.x, point.y);
                while (hit && hit.shadowRoot) {
                    const deeper = hit.shadowRoot.elementFromPoint(point.x, point.y);
                    if (!deeper || deeper === hit) break;
                    hit = deeper;
                }
                for (let node = hit; node; node = node.parentNode ?? node.host) {
                    if (node === element) return true;
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
        // Treat a hidden page as not-visible so a dashboard opened in a background tab
        // doesn't attach and stream A/V unseen; visibilitychange re-evaluates on show.
        const isIntersecting = entries[entries.length - 1].isIntersecting
            && document.visibilityState === 'visible';
        if (this.isVisibleInViewport !== isIntersecting) {
            if (document.fullscreenElement && !isIntersecting) {
                // Defer HIDING while any fullscreen is active (IO reports non-intersection
                // for cards behind the fullscreen surface). Do not mutate the flag here:
                // the pending value is committed on fullscreenchange, otherwise the
                // transition is permanently swallowed (records only fire on crossings).
                this._pendingVisibility = isIntersecting;
                return;
            }
            this._pendingVisibility = null;
            this.isVisibleInViewport = isIntersecting;
            this.applyVisibility(this.isVisibleInViewport, this.session?.background);
        }
    };

    fullscreenChanged() {
        if (document.fullscreenElement) return;
        // Restore the snapshot when leaving fullscreen ONLY if entering it is
        // what started the video (fullscreen: 'video' on an image-first
        // card). Runs here so Esc and system exits count, not just gestures.
        if (this._fullscreenResumedLive) {
            this._fullscreenResumedLive = false;
            this.session?.setViewerPaused?.(true);
        }
        const pending = this._pendingVisibility;
        this._pendingVisibility = null;
        if (pending == null || this.isVisibleInViewport === pending) return;
        // A deferred hide can be stale by exit time (layout moved during fullscreen with no
        // further IO record to correct it); committing it would detach an on-screen card
        // with nothing left to re-attach it. Verify geometrically before acting.
        if (pending === false && this.isElementActuallyVisible(this)) return;
        this.isVisibleInViewport = pending;
        this.applyVisibility(pending, this.session?.background);
    }

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
                        const boxSize = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
                        const availableheight = boxSize?.blockSize ?? entry.contentRect?.height ?? 0;
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
        document.addEventListener("fullscreenchange", this.fullscreenChanged);
        this.documentVisibilityListener = true;
    }

    removeVisibilityAndResizeHandlers() {

        this.intersectionObserver?.disconnect();
        this.intersectionObserver = null;

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        if (!this.documentVisibilityListener) return;
        document.removeEventListener("visibilitychange", this.documentVisibility);
        document.removeEventListener("fullscreenchange", this.fullscreenChanged);
        this.documentVisibilityListener = false;
    }

    /** 
    * Render new card (destructive) 
    */
    render() {

        this.rendered = false;
        this._interactionGen++;   // terminate hold-repeat loops bound to the old subtree

        // Release resources bound to the shadow DOM we are about to destroy, so they do not
        // leak across a re-render: the current snapshot object URL (whose deferred-revoke
        // timer we would otherwise clobber), and the ResizeObserver (which would keep the
        // detached .media-container alive AND stop observing the freshly-built one — silently
        // breaking PTZ auto-scaling). setupVisibilityAndResizeHandlers() re-creates the
        // observer on the new container right after render().
        if (this.shadowRoot) {
            const oldImage = this.shadowRoot.querySelector('.image');
            if (oldImage && oldImage.src && oldImage.src.startsWith('blob:')) {
                try { URL.revokeObjectURL(oldImage.src); } catch { }
            }
            if (this.displacedImageUrl) {
                try { URL.revokeObjectURL(this.displacedImageUrl); } catch { }
                this.displacedImageUrl = undefined;
            }
            clearTimeout(this.imageRefreshTimeoutId);
            this.imageRefreshTimeoutId = undefined;
            this.resizeObserver?.disconnect();
            this.resizeObserver = null;
        }

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
            this.renderAspectRatio(config.aspect_ratio);
            this.renderFullscreenFit(config.fit);
            this.renderStyle(userCardStyle);
            this.renderInteractionEventListeners();
            this.rendered = true;
        }
    }

    connectedCallback() {
        WebRTCbabycam.globalInit();

        // Cancel a pending deferred teardown: a same-tick disconnect+connect is a DOM
        // MOVE (HA edit-mode reorder, browser_mod popup hoist), not a removal.
        clearTimeout(this._pendingDetachId);
        this._pendingDetachId = undefined;

        // If we were attached before configuration, wait until config to exist
         if (!this._cardConfig) return;

        if (this.session?.state?.cards?.has(this)) {
            // card running in the background
            this.setupVisibilityAndResizeHandlers();
            return;
        }
        
        this.render();
        this.setupVisibilityAndResizeHandlers();

        clearTimeout(this.connectTimeoutId);
        this.connectTimeoutId = setTimeout(() => {
            this.connectTimeoutId = undefined;
            // Proactively evaluate visibility on mount and attach if the card is actually on
            // screen. Otherwise the card only ever attaches from an IntersectionObserver
            // callback, which can be delayed or suppressed (e.g. the fullscreenElement guard, or
            // dialog timing) inside a browser_mod popup / fullscreen kiosk — leaving it black
            // because it never connects. Off-screen dashboard cards still report not-visible here.
            if (!this.session?.state?.cards?.has(this)) {
                const actuallyVisible = this.isElementActuallyVisible(this);
                if (actuallyVisible || this.session?.background) {
                    // Only commit the flag when acting on it; unconditional overwrites here
                    // raced with (and swallowed) the IntersectionObserver's initial record.
                    this.isVisibleInViewport = actuallyVisible;
                    this.applyVisibility(actuallyVisible, this.session?.background);
                }
            }
            this.setControlsVisibility(false);
            this.setPTZVisibility(false);
            this.setDebugVisibility(WebRTCsession.globalDebug || (this.config.debug && WebRTCsession.globalDebug !== false));
        });
    }

    disconnectedCallback() {
        clearTimeout(this.connectTimeoutId);
        this.connectTimeoutId = undefined;
        this._interactionGen++;   // hold-repeat loops must not survive the DOM

        // Defer the teardown one task: the custom-element contract fires disconnected +
        // connected back-to-back for a synchronous move, and tearing down immediately
        // guarantees a black flash, a destructive shadow rebuild, and media state loss on
        // every reparent. A real removal runs the teardown one task later - still far
        // inside the session's 3s termination grace.
        clearTimeout(this._pendingDetachId);
        this._pendingDetachId = setTimeout(() => {
            this._pendingDetachId = undefined;
            if (this.isConnected) return;          // it was a move; connectedCallback kept state

            this.removeVisibilityAndResizeHandlers();
            this.isVisibleInViewport = false;
            this.applyVisibility(false, this.session?.background);

            // Release the final snapshot's object URL - blob URLs pin their Blob for the
            // document's lifetime otherwise - unless this card stayed attached as the
            // hidden background designee (its <img> must remain valid).
            if (!this.session?.state?.cards?.has(this)) {
                const img = this.shadowRoot?.querySelector('.image');
                if (img?.src?.startsWith('blob:')) {
                    try { URL.revokeObjectURL(img.src); } catch { }
                    img.removeAttribute('size');
                    img.removeAttribute('timestamp');
                    img.removeAttribute('hash');
                    img.removeAttribute('src');
                }
                if (this.displacedImageUrl) {
                    try { URL.revokeObjectURL(this.displacedImageUrl); } catch { }
                    this.displacedImageUrl = undefined;
                }
            }
        }, 0);
    }

    loadRemoteStream() {
        const { media } = this;

        const remoteStream = this.session?.activeCall?.remoteStream;
        if (!remoteStream) return;
        const same = media.srcObject === remoteStream;

        if (same) {
            this.trace("Ignoring request to reload media stream");
        } else {
            this.trace("Loading remote media stream");
            this.playGen++;
            media.srcObject = remoteStream;
            media.setAttribute('loaded', Date.now());
        }

        if (this.session?.isStreaming && !this.isPlayingActive) {
           this.playMedia();
        }
      
    }

    unloadRemoteStream() {
        const { media } = this;
        if (!media) return;
        this.stopVideoFrameMonitor();
        this.cancelPendingReveal();
        this.setMediaStale(false);
        this.live(false);
        this.clearRefreshStateTimer();
        clearTimeout(this.playTimeoutId);
        this.playTimeoutId = undefined;
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
                @keyframes livePulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
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
                    opacity: 0;
                    pointer-events: none;
                    z-index: 7;
                    transition: opacity 800ms linear, visibility 0s linear 800ms;
                }
                .media[playing="video"] ~ .live[on], .media[playing="audiovideo"] ~ .live[on] {
                    visibility: visible;
                    opacity: 1;
                    color: red;
                    transition: none;
                    animation: livePulse 2000ms ease-in-out infinite;
                }
                .media[playing="audio"] ~ .live[on] {
                    visibility: visible;
                    opacity: 1;
                    color: white;
                    transition: none;
                    animation: livePulse 2000ms ease-in-out infinite;
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

        // While lit, the dot shows an INFINITE pulse (it never self-terminates), so keeping it
        // visible requires no fragile per-tick animation restart. Each live(true) renewal —
        // driven by real media activity (rendered frames / timeupdate) and the heartbeat —
        // simply re-arms a fade timer. When renewals stop (stream dead), the timer fires,
        // `[on]` is removed, and the dot fades out via the CSS transition.
        if (on) {
            live.setAttribute("on", "");
            clearTimeout(this.liveFadeTimeoutId);
            this.liveFadeTimeoutId = setTimeout(() => {
                this.liveFadeTimeoutId = undefined;
                container.querySelector(`.live`)?.removeAttribute("on");
            }, WebRTCsession.LIVE_INDICATOR_TIMEOUT_MS);
        }
        else {
            clearTimeout(this.liveFadeTimeoutId);
            this.liveFadeTimeoutId = undefined;
            live.removeAttribute("on");
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
            // A trusted click IS a fresh user gesture: override the unmuteEnabled flag if a
            // past NotAllowedError latched it false, otherwise this tap silently does nothing.
            WebRTCsession.enableUnmute();
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
            this.trace('Cannot play media from terminated session');
            return;
        } else if (!media.srcObject) {
            this.trace('Cannot play media without source stream');
            return;
        }

        if (this.playPromise) 
        {
            this.trace('Overlapping play media request ignored');
            return this.playPromise; // don't overlap
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
        else if (WebRTCsession.unmuteEnabled && this.session?.shouldKeepBackgroundAudio) {
            // A rebuilt background-audio stream (dock tap after a muted park)
            // gets a FRESH media element: the unmute event fired before it
            // existed, so without this it plays muted forever and re-parks.
            // Global unmute is already granted — play audible.
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

        // Capture generation so late resolves don't touch current state
        const myGen = this.playGen;

        this.trace(`Media play call muted=${media.muted}, unmuteEnabled=${WebRTCsession.unmuteEnabled}, gen=${myGen}`);
       
        const playPromise = media.play()
            .then(_ => {
                if (myGen !== this.playGen) return;
                media.classList.remove('play-pending');
                if (!media.muted) {
                    media.classList.remove('unmute-pending');
                    WebRTCsession.enableUnmute();
                }
            })
            .catch(async err => {
                if (myGen !== this.playGen) return; // ignore aborts from a replaced stream
                if (err.name === "AbortError") {
                    this.trace(`Media play aborted: ${err.message}`);
                    return;
                }
                if (err.name == "NotAllowedError" && !media.muted && playMuted != true) {
                    media.classList.add('play-pending');
                    media.classList.add('unmute-pending');
                    this.trace(`${err.message}`);
                    this.trace('Unmuted play failed; retrying muted');

                    WebRTCsession.enableUnmute(false);
                    media.setAttribute('muted', '');
                    media.muted = true;
                    try {
                        await media.play();
                    } catch (retryErr) {
                        this.trace(`Muted retry failed: ${retryErr.message}`);
                    } finally {
                        // Clear on both success AND failure; a stuck 'play-pending' would
                        // permanently disable the pause auto-resume protection.
                        media.classList.remove('play-pending');
                    }
                    return;
                }
                this.trace(`Media play failed: ${err.message}`);
            })
            .finally(() => {
                // Always release the re-entrancy latch for this promise, even if the
                // generation changed mid-play (stream swap). The myGen guard only protects
                // the state mutations in then/catch above — not the latch — otherwise a
                // gen bump would leave playPromise stuck non-null and deadlock all future plays.
                if (this.playPromise === playPromise) this.playPromise = null;
            });
        this.playPromise = playPromise;
    }

    createMedia(muted) {
        const media = document.createElement('video');
        media.className = 'media';
        media.setAttribute('playsinline', '');
        media.setAttribute('webkit-playsinline', '');
        media.setAttribute('autoplay','');
        media.setAttribute('muted', '');
        media.defaultMuted = true;
        media.muted = true;
        media.playsInline = true;   // IDL attribute is camelCase; lowercase was an inert expando
        media.controls = false;
        media.autoplay = true;

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
                this.stopVideoFrameMonitor();
                // 'emptied' is NOT always teardown: some engines (notably the
                // Android WebView) re-run resource selection when a second track
                // lands on the already-playing srcObject — firing emptied ->
                // loadedmetadata -> playing on the SAME live stream. Blanking
                // 'playing' there drops the revealed video to visibility:hidden
                // for the reload gap, flashing the snapshot beneath it (the
                // video<->image shudder). Only tear down the visuals on a REAL
                // emptied — srcObject gone, or no live tracks left. A genuine
                // stream end already routes through unloadRemoteStream() (which
                // nulls srcObject before this fires), and a silent freeze ages
                // out via the stale reconciler; so keeping the last frame shown
                // across a spurious reload costs nothing and removes the flash.
                if (media.srcObject && media.srcObject.getTracks().length) {
                    break;
                }
                this.cancelPendingReveal();
                this.setMediaStale(false);
                this.live(false);
                media.removeAttribute('playing');
                media.removeAttribute('playing-started');
                media.removeAttribute('loaded');
                break;

            case 'pause':
                this.stopVideoFrameMonitor();
                this.setMediaStale(false);
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

            case 'loadedmetadata':
                this.trace('Loaded metadata');
                break;

            case 'canplay':
                // Autoplay implementation
                this.noteMediaActivity();
                this.playMedia();
                break;

            case 'play':
                this.noteMediaActivity();
                clearTimeout(this.playTimeoutId);
                this.playTimeoutId = setTimeout(() => {
                    
                    if (!this.isPlayingActive || !session?.isStreaming)
                        if (!session?.isAnyCardPlaying) {
                            this.unloadRemoteStream();
                            this.trace('Play render timeout');
                            session?.deferVideo?.('render timeout', WebRTCsession.RENDERING_TIMEOUT_MS);
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
                    this.noteMediaActivity(true); // start the monitor so the audio-flow stats fallback runs (Safari has no reliable timeupdate)
                    this.live(true);
                    this.refreshState();
                    this.refreshVolume();
                    return;
                }

                // Don't reveal on 'playing' alone: a WebRTC receiver track can
                // enter playback while still waiting on its first keyframe
                // (slow-waking doorbells), and the revealed element paints
                // opaque black over the snapshot until a frame decodes. Gate
                // the reveal on proof of a decoded frame — rVFC where the
                // engine delivers it for MediaStreams, a decoded-frame-counter
                // poll where it doesn't (iOS Safari), and a hard cap so the
                // video can never stay hidden on a silent engine. A stall
                // recovery ('playing' refiring on already-visible video)
                // reveals immediately: the gate only ever REPLACES black with
                // the snapshot, never delays a real frame.
                const reveal = () => {
                    this.cancelPendingReveal();

                    if (!session || session.isTerminated) return;
                    if (this.media !== media || !media.srcObject?.getVideoTracks?.().length) return;
                    if (media.getAttribute('playing') === 'paused') return;

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
                    this.noteMediaActivity(true);

                    this.live(true);
                    this.refreshState();
                    this.refreshVolume();
                };

                // videoWidth > 0 means frame data already exists (metadata from
                // real frames) — reveal immediately. Only a genuinely frameless
                // track (Chromium pre-keyframe) defers, and only until rVFC
                // proves a painted frame or the hard cap lands. Engines that
                // never deliver rVFC for MediaStreams (iOS Safari) ride the
                // cap; nothing here can strand the reveal.
                const alreadyVisible = ['audiovideo', 'video'].includes(media.getAttribute('playing'));
                if (alreadyVisible || media.videoWidth > 0) {
                    reveal();
                    break;
                }

                this.cancelPendingReveal();
                this.trace('Deferring video reveal until first decoded frame');
                if (typeof media.requestVideoFrameCallback === 'function') {
                    try {
                        this.revealFrameCallbackId = media.requestVideoFrameCallback(() => {
                            this.revealFrameCallbackId = undefined;
                            this.trace('Video revealed on first presented frame');
                            reveal();
                        });
                    } catch {
                        this.revealFrameCallbackId = undefined;
                    }
                }
                this.revealTimeoutId = setTimeout(() => {
                    this.revealTimeoutId = undefined;
                    this.trace('Video revealed on reveal timeout');
                    reveal();
                }, WebRTCsession.REVEAL_TIMEOUT_MS);
                break;

            case 'timeupdate':
                // For a MediaStream source, currentTime is a real-time clock: it advances
                // while the element is 'potentially playing' even when NO media data
                // arrives, so feeding it into the freeze detector would mask a frozen
                // stream forever. While a peer connection exists, liveness comes from
                // requestVideoFrameCallback and the getStats fallback; keep timeupdate as
                // the liveness feed only for non-WebRTC playback where stats are absent.
                if (!session?.activeCall?.peerConnection) {
                    this.noteMediaActivity();
                }
                break;

            case 'waiting':
                this.stopVideoFrameMonitor();
                if (session?.shouldKeepBackgroundAudio) {
                    this.setMediaStale(false, false);
                    break;
                }
                // 'waiting' (buffer underrun) is normal/transient on a live stream and usually
                // recovers within a frame or two. Debounce the blur so the picture stays clear on
                // brief stalls; only blur if the wait actually persists past the grace window.
                this.scheduleMediaStale(WebRTCsession.MEDIA_STALE_GRACE_MS);
                break;

            case 'stalled':
                // Per spec 'stalled' belongs to the remote-mode resource fetch algorithm;
                // MediaStream (srcObject) playback uses local mode, so Firefox/Safari never
                // fire it and Chromium's occurrences are documented noise from a healthy
                // stream. Never treat it as fatal - at most start the debounced stale check
                // (like 'waiting') and let the frame monitor make the real call.
                if (session?.shouldKeepBackgroundAudio) {
                    this.setMediaStale(false, false);
                    break;
                }
                this.scheduleMediaStale(WebRTCsession.MEDIA_STALE_GRACE_MS);
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
                session?.noteInterest?.();
                if (media.controls) {
                    this.setControlsVisibility(true);
                }
                break;

            case 'error': {
                this.stopVideoFrameMonitor();
                const code = media.error?.code ?? 'unknown';
                const message = media.error?.message ?? 'unknown';
                this.lastError = message;
                // refreshState() renders the error tooltip from session.lastError, so a
                // card-only assignment above would never surface. Mirror it onto the session.
                if (session) session.lastError = message;
                if (session?.shouldKeepBackgroundAudio) {
                    this.setMediaStale(false, false);
                    this.trace(`Media error ${code}; details: ${message}`);
                    session?.restartCall?.();
                    break;
                }
                this.setMediaStale(true, false);
                session?.deferVideo?.('media error', WebRTCsession.RENDERING_TIMEOUT_MS);
                this.trace(`Media error ${code}; details: ${message}`);
                break;
            }

            default:
                this.trace(`Unhandled media event: ${ev.type}`);
        }
    }
}

if (!customElements.get('webrtc-babycam')) customElements.define('webrtc-babycam', WebRTCbabycam);

// Register the card for Home Assistant
const customCardRegistrationFinal = {
    type: 'webrtc-babycam',
    name: 'WebRTC Baby Camera',
    preview: false,
    description: `WebRTC babycam provides a lag-free 2-way audio, video, and image camera card. (v${CARD_VERSION})`
};
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === customCardRegistrationFinal.type)) {
    window.customCards.push(customCardRegistrationFinal);
}


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
        this.candidateControllers = new Set();
        this.sessionUrl = null;        // per-session resource from the 201 Location header
        this.queuedCandidates = [];    // gathered before the 201 (WHEP: player MUST buffer)
        this.answered = false;
        this.trickleSupported = true;  // flips false on 405/501 PATCH responses
        this.closed = false;
    }
    generateSdpFragment(offerData, candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) return '';
        const candidatesByMedia = {};
        for (const candidate of candidates) {
            const mid = candidate?.sdpMLineIndex;
            if (mid == null) continue;
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
        // false after close() so the renegotiation guard correctly routes a closed
        // channel into restartCall instead of PATCHing a dead session.
        return !this.closed;
    }
    close() {
        if (this.httpTimeoutId) {
            clearTimeout(this.httpTimeoutId);
            this.httpTimeoutId = undefined;
        }
        if (this.controller)
            this.controller.abort();
        for (const controller of this.candidateControllers) {
            try { controller.abort(); } catch { }
        }
        this.candidateControllers.clear();
        this.queuedCandidates = [];
        this.answered = false;
        if (this.sessionUrl) {
            // WHEP: the player MUST DELETE the session resource on teardown. Fire and
            // forget (keepalive survives pagehide) so the unbounded-reconnect design never
            // blocks on it - but without it every restart leaks a live server session.
            try { fetch(this.sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => { }); } catch { }
            this.sessionUrl = null;
        }
        this.closed = true;
    }
    async sendCandidate(candidate) {
        if (!candidate) return;                    // end-of-candidates needs no PATCH
        if (!this.trickleSupported || this.closed) return;
        if (!this.offerData) {
            if (this.onerror) this.onerror(new Error('Offer data not set before sending candidates.'));
            return;
        }
        if (!this.answered) {
            // WHEP: candidates gathered before the 201 response MUST be buffered; they are
            // flushed by sendOffer. Gate on the answer ALONE - patchCandidates already
            // falls back to the endpoint URL when the 201 carried no usable Location, so
            // post-answer candidates must not be queued forever on such servers.
            this.queuedCandidates.push(candidate);
            return;
        }
        await this.patchCandidates([candidate]);
    }
    async patchCandidates(candidates) {
        const sdpFrag = this.generateSdpFragment(this.offerData, candidates);
        if (!sdpFrag) return;
        const controller = new AbortController();
        this.candidateControllers.add(controller);
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
            // PATCH targets the per-session resource from the Location header, not the
            // endpoint; If-Match is omitted entirely when no ETag was provided (an empty
            // If-Match field value is malformed).
            const headers = { 'Content-Type': 'application/trickle-ice-sdpfrag' };
            if (this.eTag) headers['If-Match'] = this.eTag;
            const response = await fetch(this.sessionUrl ?? this.url, {
                signal: controller.signal,
                method: 'PATCH',
                headers,
                body: sdpFrag,
            });
            if (response.status === 405 || response.status === 501) {
                // Server does not implement trickle ICE; stop PATCHing quietly - the
                // candidates already flow through the SDP exchange.
                this.trickleSupported = false;
                this.ontrace?.('WHEP server does not support trickle ICE; disabling PATCH');
            }
            else if (response.status !== 204 && response.status !== 200) {
                throw new Error(`sendCandidate bad status code ${response.status}`);
            }
        }
        catch (err) {
            if (this.onerror && !this.closed) this.onerror(err);
        }
        finally {
            clearTimeout(timeoutId);
            this.candidateControllers.delete(controller);
        }
    }
    async sendOffer(desc) {
        this.close();                              // DELETEs any previous session (renegotiation)
        this.closed = false;                       // reopening with a fresh offer
        this.answered = false;
        this.eTag = '';
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
                this.eTag = response.headers.get('ETag') || response.headers.get('E-Tag') || '';
                const location = response.headers.get('Location');
                if (location) {
                    // Resolve against an absolute base: config.url may itself be relative
                    // (fetch resolves it against the document, but the URL constructor
                    // requires an absolute base or it throws even for a valid Location).
                    try { this.sessionUrl = new URL(location, new URL(this.url, window.location.href)).href; }
                    catch { this.sessionUrl = null; }
                }
                if (!this.sessionUrl) {
                    this.ontrace?.('WHEP 201 without usable Location header; trickle PATCH will target the endpoint URL and no DELETE will be sent');
                }
                if (this.onanswer) {
                    // WHEP answers are raw application/sdp, not URL-encoded; decoding here
                    // could corrupt valid '%' sequences or throw URIError on a stray '%'.
                    const sdp = await response.text();
                    this.onanswer({
                        type: 'answer',
                        sdp: sdp
                    });
                }
                this.answered = true;
                const queued = this.queuedCandidates.splice(0);
                if (queued.length && this.trickleSupported && !this.closed) {
                    await this.patchCandidates(queued);
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

            // Settle a pending open() BEFORE detaching the listeners that would otherwise
            // reject it: close() during CONNECTING must not leave the caller (startCall,
            // suspended at await open()) waiting forever with the play-loop latch held.
            if (this._rejectOpen) {
                this._rejectOpen(new Error('Signaling channel closed'));
                this._resolveOpen = null;
                this._rejectOpen = null;
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

class HomeAssistantSignalingChannel extends SignalingChannel {
    // Opt in per card with `url_type: hass` (`url` is then unused). Signals through Home
    // Assistant's native camera WebRTC websocket API (camera/webrtc/get_client_config |
    // offer | candidate), served by the built-in go2rtc integration or any other
    // registered camera WebRTC provider. Rides the card's already-authenticated HA
    // connection: no second websocket, no signed paths, no custom-integration proxy.
    // Requires HA 2024.11+ and a camera entity whose stream a provider supports.
    //
    // Caveat: HA's go2rtc provider re-ingests the camera's RTSP stream into its own
    // go2rtc instance, which adds a hop and latency versus signaling straight to a
    // go2rtc that already holds the stream. Frigate's own `enable_webrtc` avoids that
    // hop but discards trickle ICE candidates entirely.
    constructor(hass, entityId) {
        super();
        this.hass = hass;
        this.entityId = entityId;
        // RTCConfiguration advertised by the server via get_client_config; the session
        // reads this after open() so createPeer can use HA-managed STUN/TURN.
        this.clientConfiguration = null;
        this.sessionId = null;
        this._unsubPromise = null;
        this._opened = false;
        this._closed = false;
        // Local candidates gathered before the server assigns a session_id; flushed on
        // the 'session' event (same strategy as HA's own ha-web-rtc-player).
        this._pendingLocalCandidates = [];
    }

    get isOpen() {
        return this._opened && !this._closed;
    }

    async open(timeout) {
        if (this._opened || this._closed) throw new Error('Signaling channel cannot be reopened');
        if (!this.hass?.connection) throw new Error('Home Assistant connection is not available');

        // Advisory fetch: a camera that rejects get_client_config will report the real,
        // actionable error on the offer itself, so failure here only costs the advertised
        // ICE servers - never the call.
        try {
            const response = await Promise.race([
                this.hass.callWS({
                    type: 'camera/webrtc/get_client_config',
                    entity_id: this.entityId
                }),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`get_client_config timed out after ${timeout}ms`)), timeout))
            ]);
            this.clientConfiguration = response?.configuration ?? null;
        } catch (err) {
            this.trace(`get_client_config failed: ${err.message}`);
        }

        this._opened = true;
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._pendingLocalCandidates = [];
        const unsubPromise = this._unsubPromise;
        this._unsubPromise = null;
        if (unsubPromise) {
            // Must stay synchronous (endCallFast runs inside pagehide): fire-and-forget.
            // Unsubscribing closes the server-side session (camera.close_webrtc_session);
            // when the page is going away the HA socket teardown performs the same cleanup.
            unsubPromise.then(unsub => unsub()).catch(() => { });
        }
    }

    async sendOffer(rtcSessionDescription) {
        if (!this.isOpen) throw new Error('Cannot send offer because the signaling channel is not open');
        if (this._unsubPromise) throw new Error('Offer already sent on this signaling channel');

        // camera/webrtc/offer is a subscription: the command result acknowledges it, then
        // events deliver session/answer/candidate/error. resubscribe:false because after
        // an HA socket reconnect the server-side session is gone; the card's own watchdog
        // restarts the call instead.
        this._unsubPromise = this.hass.connection.subscribeMessage(
            (event) => this.handleEvent(event),
            {
                type: 'camera/webrtc/offer',
                entity_id: this.entityId,
                offer: rtcSessionDescription.sdp
            },
            { resubscribe: false }
        );
        await this._unsubPromise;
    }

    async sendCandidate(rtcIceCandidate) {
        if (!this.isOpen) throw new Error('Cannot send candidate because the signaling channel is not open');
        // The native API has no end-of-candidates message; the server infers completion.
        if (!rtcIceCandidate?.candidate) return;

        if (!this.sessionId) {
            this._pendingLocalCandidates.push(rtcIceCandidate);
            this.trace('Queued local ICE candidate until session is established');
            return;
        }

        try {
            await this.hass.callWS({
                type: 'camera/webrtc/candidate',
                entity_id: this.entityId,
                session_id: this.sessionId,
                candidate: rtcIceCandidate.toJSON ? rtcIceCandidate.toJSON() : rtcIceCandidate
            });
        } catch (err) {
            // A dropped candidate is non-fatal (remaining pairs usually still connect) and
            // the call site does not await sendCandidate - trace instead of rejecting.
            this.trace(`Failed to send ICE candidate: ${err.message}`);
        }
    }

    handleEvent(event) {
        if (this._closed) return;
        switch (event?.type) {
            case 'session': {
                this.sessionId = event.session_id;
                this.trace(`Session established: ${event.session_id}`);
                for (const pendingCandidate of this._pendingLocalCandidates.splice(0)) {
                    this.sendCandidate(pendingCandidate);
                }
                break;
            }
            case 'answer':
                if (this.onanswer) {
                    this.onanswer({ type: 'answer', sdp: event.answer });
                }
                break;
            case 'candidate':
                if (this.oncandidate) {
                    const init = event.candidate;
                    // Match ha-web-rtc-player: a provider may omit both sdpMid and
                    // sdpMLineIndex, which addIceCandidate rejects - anchor to mid "0".
                    const candidate = (init?.sdpMid ?? null) !== null || (init?.sdpMLineIndex ?? null) !== null
                        ? init
                        : { candidate: init?.candidate, sdpMid: '0' };
                    this.oncandidate(candidate);
                }
                break;
            case 'error':
                if (this.onerror) {
                    this.onerror(new Error(`${event.code}: ${event.message}`));
                }
                this.close();
                break;
            default:
                this.trace(`Unhandled camera/webrtc event type: ${event?.type}`);
                break;
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
                const stringValue = await response.text();
                if (response.ok) {
                    if (this.onanswer) {
                        // Decode only if the server URL-encoded its answer; otherwise a stray
                        // '%' would throw URIError and lose the answer. Fall back to raw text.
                        let answerSdp = stringValue;
                        try { answerSdp = decodeURIComponent(stringValue); } catch { /* not URL-encoded */ }
                        this.onanswer({ type: "answer", sdp: answerSdp });
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

///////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////
/////////////////////////////////

/**
 * BackgroundManager - owns background mode's persistence, fail-safes, and the minimized dock.
 *
 * - Persistent registry: ONE localStorage JSON key ('webrtc.background.v2') holding, per
 *   session key: enabled, entity, friendlyName, returnPath, lastAliveAt, startedAt. Replaces
 *   the legacy per-key 'webrtc.<key>.background' strings (migrated once, then removed) and is
 *   garbage-collected so config-hash key changes can no longer strand orphaned flags.
 * - Cross-tab coordination: BroadcastChannel plus a 'storage'-event fallback (both work on
 *   plain-http HA origins; Web Locks does not). At most one tab holds a given hidden
 *   background stream; enable/disable in any tab converges everywhere.
 * - Lease/heartbeat: lastAliveAt is refreshed while a tab holds the stream; a crashed tab's
 *   entry goes stale within LEASE_STALE_MS and shows up as 'suspended' (tap to reopen).
 * - Page lifecycle: pagehide/freeze release the lease and close transports synchronously;
 *   pageshow(persisted)/resume re-claim and kick the watchdog immediately.
 * - Throttling fail-safe: while this tab holds a hidden background stream, a tiny dedicated
 *   Worker (immune to hidden-page timer throttling) keeps lease heartbeats flowing and kicks
 *   a starved watchdog so reconnects don't degrade to one attempt per minute.
 * - MediaSession: lock-screen/OS media surface for the audible background stream.
 */
class BackgroundManager {
    static REGISTRY_KEY = 'webrtc.background.v2';
    static MSG_KEY = 'webrtc.background.msg';
    static CHANNEL_NAME = 'webrtc-babycam:background';
    static HEARTBEAT_INTERVAL_MS = 15000;
    static LEASE_STALE_MS = 90000;                   // > 1/min worst-case throttled heartbeat
    static LEGACY_ORPHAN_GC_MS = 14 * 24 * 3600000;
    static ORPHAN_GC_MS = 30 * 24 * 3600000;
    static TICKER_INTERVAL_MS = 5000;
    static WATCHDOG_OVERDUE_MS = 7500;

    static getInstance() {
        const root = topWindow;
        const sym = (root.__webrtcManagerSym ||= Symbol.for('webrtc-babycam:manager'));
        let manager = root[sym];
        if (manager && !BackgroundManager.isManagerAlive(manager)) {
            manager = null;
        }
        if (!manager) {
            manager = new BackgroundManager(root);
            root[sym] = manager;
            manager.init();
        }
        return manager;
    }

    static isManagerAlive(manager) {
        try { return !!manager.ownerWindow?.document?.defaultView; } catch { return false; }
    }

    constructor(root) {
        this.root = root;
        this.ownerWindow = window;
        this.eventTarget = new EventTarget();
        this.tabId = `tab-${randomSalt()}`;
        this.registry = {};                    // in-memory cache of the parsed registry
        this.storageOk = true;
        this.channel = null;
        this.dock = null;
        this.dockRefreshTimeoutId = undefined;
        this.heartbeatIntervalId = undefined;
        this.lastLeaseWriteByKey = new Map();
        this.visibleKeys = new Set();          // session keys with a visible card in THIS tab
        this.adoptedSessions = new WeakSet();
        this.tickerWorker = null;
        this.tickerUrl = null;
        this.mediaSessionKey = null;
        this._keepAliveLockRelease = null;
        this._keepAliveLockPending = false;
        this._keepAliveLockAbandoned = false;
    }

    init() {
        this.loadRegistry();
        this.migrateLegacyEntries();
        this.collectGarbage();
        this.openChannel();
        this.installLifecycleHandlers();
        this.heartbeatIntervalId = setInterval(() => this.heartbeatTick(), BackgroundManager.HEARTBEAT_INTERVAL_MS);
        this.ensureDock();
    }

    // ------------------------------------------------------------------ registry

    loadRegistry() {
        // While persistence is failing (quota/private mode), memory is the authority:
        // re-reading would clobber newer in-memory state with stale storage.
        if (!this.storageOk) return;
        const raw = safeStorage.get(BackgroundManager.REGISTRY_KEY);
        if (raw == null) {
            if (Object.keys(this.registry).length === 0) this.registry = {};
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            this.registry = (parsed && parsed.v === 2 && parsed.sessions) ? parsed.sessions : {};
        } catch {
            // corrupted JSON: quarantine and reset; never throw into the background getter
            safeStorage.set('webrtc.background.corrupt', raw);
            safeStorage.remove(BackgroundManager.REGISTRY_KEY);
            this.registry = {};
        }
    }

    writeRegistry(mutator) {
        // Read-modify-write merge: no cross-tab lock exists on plain http, so re-read the
        // latest before writing to shrink the race window; entry updates are idempotent.
        this.loadRegistry();
        mutator(this.registry);
        this.storageOk = safeStorage.set(BackgroundManager.REGISTRY_KEY,
            JSON.stringify({ v: 2, sessions: this.registry }));
        this.eventTarget.dispatchEvent(new CustomEvent('registry'));
    }

    entry(key) { return this.registry[key]; }

    isEnabled(key, configDefault = false) {
        // HOT PATH: called from shouldKeepBackgroundAudio on every media event.
        // Pure in-memory read; the cache refreshes on storage/channel events + heartbeat.
        const e = this.registry[key];
        if (e && typeof e.enabled === 'boolean') return e.enabled;
        return configDefault === true;
    }

    setEnabled(key, enabled, meta = {}) {
        const before = this.registry[key]?.enabled === true;
        this.writeRegistry(reg => {
            const e = reg[key] ?? (reg[key] = {});
            e.enabled = enabled;
            if (meta.entity) e.entity = meta.entity;
            if (meta.friendlyName) e.friendlyName = meta.friendlyName;
            // Only seed a missing returnPath on enable. Disabling (or re-enabling via the
            // dock from an unrelated page) must not overwrite the card's real dashboard
            // path with wherever the dock happened to be clicked; noteCardVisible keeps
            // the path fresh from the card's actual view.
            if (meta.returnPath && enabled && !e.returnPath) e.returnPath = meta.returnPath;
            if (meta.config) e.config = meta.config;
            if (meta.dock === false) e.dock = false; else delete e.dock;
            e.lastAliveAt = Date.now();
            if (enabled && !before) e.startedAt = Date.now();
            delete e.legacy;
        });
        this.dispatchBackgroundEvent(key, enabled);
        this.broadcast({ type: 'set-enabled', key, enabled });
        if (!enabled) document.querySelector(`div[data-babycam-background-host="${key}"]`)?.remove();
        this.refreshDock();
    }

    dispatchBackgroundEvent(key, enabled) {
        const session = WebRTCsession.sessions.get(key);
        session?.eventTarget.dispatchEvent(
            new CustomEvent('background', { detail: { background: enabled } }));
    }

    // ------------------------------------------------------------------ migration & GC

    migrateLegacyEntries() {
        const legacyKeys = safeStorage.keys(/^webrtc\.(.+)\.background$/);
        if (legacyKeys.length === 0) return;
        this.writeRegistry(reg => {
            for (const storageKey of legacyKeys) {
                const sessionKey = storageKey.slice('webrtc.'.length, -'.background'.length);
                if (reg[sessionKey]) continue;                       // v2 already authoritative
                const value = safeStorage.get(storageKey);
                reg[sessionKey] = {
                    // preserve stored FALSE overrides too: they suppress config.background=true
                    enabled: String(value).toLowerCase() === 'true',
                    entity: null, friendlyName: null, returnPath: null,
                    lastAliveAt: Date.now(), startedAt: 0, legacy: true
                };
            }
        });
        // Never destroy the source of truth if the v2 write did not persist.
        if (!this.storageOk) return;
        for (const storageKey of legacyKeys) safeStorage.remove(storageKey);
    }

    collectGarbage() {
        const now = Date.now();
        this.writeRegistry(reg => {
            for (const [key, e] of Object.entries(reg)) {
                const idleMs = now - Math.max(e.lastAliveAt ?? 0, e.startedAt ?? 0);
                if (e.legacy && idleMs > BackgroundManager.LEGACY_ORPHAN_GC_MS) delete reg[key];
                else if (idleMs > BackgroundManager.ORPHAN_GC_MS) delete reg[key];
            }
        });
    }

    reapConfigChangeOrphans(session) {
        // The session key embeds a hash of url/url_type/image_url/microphone, so editing a
        // card's config orphans its old entry AND silently loses the user's pin. Migrate the
        // precise case "same entity, same dashboard view, different hash, not running
        // anywhere" - i.e. the same card, reconfigured - then reap the old entry.
        const here = this.currentPath();
        // Key format: <entity-sanitized>[-a][-v]-<variantHash36>. Requiring an identical
        // prefix (everything but the trailing hash) means "same entity AND same audio/video
        // capabilities, only the url/image/microphone variant changed" - a sibling card of
        // the same entity with different capabilities keeps its own pin.
        const prefixOf = (k) => {
            const idx = String(k).lastIndexOf('-');
            return idx > 0 ? String(k).slice(0, idx) : String(k);
        };
        const sessionPrefix = prefixOf(session.key);
        const isOrphan = (key, e) => key !== session.key
            && e && e.entity === session.config.entity
            && prefixOf(key) === sessionPrefix
            && e.returnPath === here
            && Date.now() - (e.lastAliveAt ?? 0) >= BackgroundManager.LEASE_STALE_MS;
        // pre-scan the in-memory cache so the common no-orphan case costs no storage write
        if (!Object.entries(this.registry).some(([key, e]) => isOrphan(key, e))) return;
        this.writeRegistry(reg => {
            for (const [key, e] of Object.entries(reg)) {
                if (!isOrphan(key, e)) continue;
                if (e.enabled === true && !reg[session.key]) {
                    reg[session.key] = { ...e, legacy: false };
                }
                delete reg[key];
            }
        });
    }

    // ------------------------------------------------------------------ cross-tab channel

    openChannel() {
        try {
            if ('BroadcastChannel' in window) {    // available on http; NOT secure-context-only
                this.channel = new BroadcastChannel(BackgroundManager.CHANNEL_NAME);
                this.channel.onmessage = ev => this.onChannelMessage(ev.data);
            }
        } catch { this.channel = null; }
        // storage fallback ALWAYS installed too (old WebViews; doubles as reconciler):
        window.addEventListener('storage', ev => {
            if (ev.key === BackgroundManager.REGISTRY_KEY) {
                this.loadRegistry();
                this.reconcileSessions();
                this.refreshDockThrottled();
            }
            else if (ev.key === BackgroundManager.MSG_KEY && ev.newValue) {
                try { this.onChannelMessage(JSON.parse(ev.newValue)); } catch { }
            }
        });
    }

    broadcast(msg) {
        msg.tabId = this.tabId;
        msg.nonce = Math.random();                 // distinct storage events for repeat messages
        try { this.channel?.postMessage(msg); } catch { }
        safeStorage.set(BackgroundManager.MSG_KEY, JSON.stringify(msg));
    }

    broadcastClaim(key, priority = 'hidden') {
        this.broadcast({ type: 'claim', key, priority });
    }

    onChannelMessage(msg) {
        if (!msg || msg.tabId === this.tabId) return;
        switch (msg.type) {
            case 'set-enabled':
                this.loadRegistry();
                this.dispatchBackgroundEvent(msg.key, msg.enabled === true);
                this.refreshDockThrottled();
                break;
            case 'claim': {
                // Another tab's card took over this key: release OUR hidden designee so a
                // single tab streams (visible cards are exempt - multi-viewer is legitimate).
                const session = WebRTCsession.sessions.get(msg.key);
                if (session?.state.backgroundCard) {
                    if (msg.priority === 'visible') {
                        // A tab with an on-screen viewer ALWAYS beats a hidden holder;
                        // tie-breaking here would leave a duplicate hidden stream running.
                        session.releaseBackground();
                    }
                    // Hidden vs hidden: tie-break deterministically by tabId. When two tabs
                    // claim simultaneously exactly one must yield - otherwise both release
                    // and the stream dies, or both hold and double-stream.
                    else if (String(msg.tabId) > String(this.tabId)) {
                        session.releaseBackground();
                    } else {
                        // We outrank the claimer; reassert so the other tab yields instead.
                        this.broadcast({ type: 'claim', key: msg.key, priority: 'hidden' });
                    }
                }
                this.refreshDockThrottled();
                break;
            }
        }
    }

    reconcileSessions() {
        // Cross-tab disable that arrived only via storage: unwind any hidden designee whose
        // registry entry no longer says enabled (previously this stream ran on orphaned).
        for (const session of WebRTCsession.sessions.values()) {
            if (session.state.backgroundCard && !session.background) {
                this.dispatchBackgroundEvent(session.key, false);
            }
        }
    }

    // ------------------------------------------------------------------ lease / heartbeat

    adoptSession(session) {
        if (this.adoptedSessions.has(session)) return;
        this.adoptedSessions.add(session);

        // Sessions whose background mode comes from `background: true` CONFIG (never pinned
        // via the UI) would otherwise have no registry entry: no dock chip, no lease, and
        // silent park states. Materialize an entry so all fail-safes apply uniformly.
        if (session.background && !this.entry(session.key)) {
            this.writeRegistry(reg => {
                if (!reg[session.key]) {
                    reg[session.key] = {
                        enabled: true,
                        entity: session.config.entity,
                        friendlyName: session.config.entity,
                        returnPath: null,
                        lastAliveAt: Date.now(),
                        startedAt: Date.now()
                    };
                }
            });
        }

        const bus = session.eventTarget;
        bus.addEventListener('heartbeat', () => {
            if (session.background && session.state.cards.size > 0) this.noteAlive(session.key);
            this.refreshDockThrottled();
        });
        bus.addEventListener('status', () => this.refreshDockThrottled());
        bus.addEventListener('parked', () => this.refreshDock());
        bus.addEventListener('mute', () => this.refreshDockThrottled());
        bus.addEventListener('unmuteEnabled', (ev) => {
            if (ev.detail?.unmuteEnabled && session.parked === 'muted') session.unpark();
            this.refreshDockThrottled();
        });
    }

    noteAlive(key) {
        const last = this.lastLeaseWriteByKey.get(key) ?? 0;
        if (Date.now() - last < BackgroundManager.HEARTBEAT_INTERVAL_MS) return;
        this.lastLeaseWriteByKey.set(key, Date.now());
        this.writeRegistry(reg => {
            if (reg[key]) {
                reg[key].lastAliveAt = Date.now();
                reg[key].heldBy = this.tabId;
            }
        });
    }

    releaseLease(key) {
        // Age the lease out immediately so other tabs' docks flip to 'suspended' now
        // instead of after LEASE_STALE_MS - but only when THIS tab holds it; a session
        // terminating here must not age out a lease another tab is keeping fresh.
        this.lastLeaseWriteByKey.delete(key);
        this.writeRegistry(reg => {
            const e = reg[key];
            if (e && (!e.heldBy || e.heldBy === this.tabId)) {
                e.lastAliveAt = Date.now() - BackgroundManager.LEASE_STALE_MS;
                delete e.heldBy;
            }
        });
    }

    heartbeatTick() {
        this.loadRegistry();
        this.reconcileSessions();
        this.ensureDock();
        this.updateTicker();
        this.refreshDock();
    }

    // ------------------------------------------------------------------ card notifications

    noteCardVisible(session, card) {
        this.visibleKeys.add(session.key);
        if (session.background) {
            const meta = session.describeForRegistry();
            this.writeRegistry(reg => {
                const e = reg[session.key];
                if (e) {
                    // last-visible moment beats pin-time capture: 'return' goes
                    // where the user actually was, even if they pinned on a
                    // different dashboard. ONLY a card the viewer can actually
                    // SEE may refresh it: synthetic visible passes (the
                    // hidden-designee re-arm dance, background resurrection)
                    // would clobber the path with wherever the page happens to
                    // be — leaving the dock's return shortcut pointing at the
                    // current view, a silent no-op.
                    if (card.isVisibleInViewport) {
                        e.returnPath = meta.returnPath;
                    }
                    if (!e.entity) e.entity = meta.entity;
                    if (meta.friendlyName) e.friendlyName = meta.friendlyName;
                    // keep the resurrection config fresh: card edits since the
                    // pin (or a pre-config-persistence pin) land here
                    if (meta.config) e.config = meta.config;
                    e.lastAliveAt = Date.now();
                    delete e.legacy;
                }
            });
            this.broadcast({ type: 'claim', key: session.key, priority: 'visible' });
        }
        this.reapConfigChangeOrphans(session);
        this.refreshDockThrottled();
    }

    noteCardHidden(session, card) {
        if (![...session.state.cards].some(c => c.isVisibleInViewport)) {
            this.visibleKeys.delete(session.key);
        }
        this.updateTicker();
        this.refreshDockThrottled();
    }

    // ------------------------------------------------------------------ navigation & dock actions

    currentPath() {
        try { const l = this.root.location; return l.pathname + l.search; }
        catch { const l = window.location; return l.pathname + l.search; }
    }

    navigate(path) {
        // HA frontend convention (src/common/navigate.ts): pushState on the
        // window hosting HA, then 'location-changed' as a CustomEvent — the
        // same shape the card's own HA-action handler uses.
        try {
            this.root.history.pushState(null, '', path);
            this.root.dispatchEvent(
                new CustomEvent('location-changed', {
                    bubbles: true,
                    composed: true,
                    detail: { replace: false },
                })
            );
        } catch {
            try { window.location.assign(path); } catch { }
        }
    }

    // iOS continues BACKGROUND audio only for playback that began inside a
    // user gesture: a resurrected session's element started autoplay-muted,
    // and merely unmuting it later leaves the playback gesture-less — the
    // moment the app minimizes, WebKit suspends it. Re-issue play()
    // SYNCHRONOUSLY inside the dock tap so the element is re-marked as
    // gesture-initiated and survives minimizing like an organically
    // backgrounded stream.
    gestureAnchorPlayback(key) {
        const media = WebRTCsession.sessions.get(key)?.state?.backgroundCard?.media;
        if (media && media.srcObject) {
            try { media.play()?.catch?.(() => { }); } catch { }
        }
    }

    dockReturn(key) {
        WebRTCsession.enableUnmute();              // the tap IS the autoplay gesture
        this.gestureAnchorPlayback(key);
        const session = WebRTCsession.sessions.get(key);
        session?.unpark?.();
        const e = this.entry(key);
        if (!e?.returnPath) {
            // Never a silent no-op: without a stored path the shortcut can't
            // navigate — say so where a bug report can see it.
            console.warn('webrtc-babycam: dock return has no stored path for', key);
            return;
        }
        if (e.returnPath !== this.currentPath()) {
            this.navigate(e.returnPath);
        }
        // if already on the right view, the card's IntersectionObserver takes it from here
    }

    dockResume(key) {
        WebRTCsession.enableUnmute();
        this.gestureAnchorPlayback(key);
        const session = WebRTCsession.sessions.get(key);
        if (session) {
            session.unpark();
            session.kick();
        }
        else {
            // reload with no session yet: the chip tap is a user gesture, so
            // the resurrected stream starts with activation in hand
            this.resurrectSuspendedSessions();
        }
        this.refreshDockThrottled();
    }

    async resurrectSuspendedSessions() {
        // Pinned background streams survive a page (re)load: mount an
        // offscreen host card from the registry's stored config for every
        // enabled entry with no session, and hand it straight to designee
        // state (offscreen — NOT hidden-in-place — so the card reads as
        // not-visible and stays on the background path). Kiosks with
        // autoplay allowances resume hands-off; restricted browsers park
        // 'muted' loudly in the dock, one tap from live.
        this.loadRegistry();
        const wanted = Object.entries(this.registry).filter(([key, e]) =>
            e?.enabled === true && e.config && !WebRTCsession.sessions.get(key));
        if (!wanted.length) return;

        // the resource loads before the frontend's hass settles
        for (let i = 0; i < 240 && !WebRTCsession.resolveHass(); i++) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!WebRTCsession.resolveHass()) return;

        for (const [key, e] of wanted) {
            if (WebRTCsession.sessions.get(key)) continue;   // a real card won the race
            try {
                const host = document.createElement('div');
                host.dataset.babycamBackgroundHost = key;
                host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
                const card = document.createElement('webrtc-babycam');
                card.setConfig({ ...e.config });
                host.appendChild(card);
                document.body.appendChild(host);
                card.attachAsBackgroundDesignee();
            } catch (err) {
                console.warn('babycam: background resurrection failed for', key, err);
            }
        }
    }

    dockClose(key) {
        // SOFT close: stop the audio NOW (park) but keep the designee attached through the
        // dock's undo window, so UNDO can genuinely resume the live stream. A hard unpin
        // here would detach the designee, the 3s termination grace would kill the session,
        // and a 5s undo could only ever re-arm - never resume.
        const session = WebRTCsession.sessions.get(key);
        if (session && session.state.cards.size > 0 && !session.isTerminated) {
            session.park('closing');
        } else {
            this.setEnabled(key, false);           // nothing streaming here: plain unpin
        }
        this.refreshDockThrottled();
    }

    dockCloseFinal(key) {
        // Undo window elapsed: commit the close as a full unpin (preference cleared).
        const session = WebRTCsession.sessions.get(key);
        if (session && session.background) {
            session.background = false;            // routes through setEnabled + 'background' event
        } else {
            this.setEnabled(key, false);
        }
    }

    dockUndo(key) {
        const session = WebRTCsession.sessions.get(key);
        if (session && session.parked === 'closing') {
            session.unpark();                      // resume the still-attached designee
        } else if (!this.isEnabled(key)) {
            this.setEnabled(key, true);
        }
        this.refreshDockThrottled();
    }

    snapshot() {
        const now = Date.now();
        const chips = [];
        for (const [key, e] of Object.entries(this.registry)) {
            if (!e || e.enabled !== true) continue;
            if (e.dock === false) continue;
            if (this.visibleKeys.has(key)) continue;
            const session = WebRTCsession.sessions.get(key);
            let state;
            if (session && session.state.cards.size > 0 && !session.isTerminated) {
                const designee = session.state.backgroundCard;
                if (session.parked === 'muted') state = 'blocked';
                else if (session.parked) state = 'expired';
                else if (designee?.media?.muted && designee.media.classList.contains('unmute-pending')) state = 'blocked';
                else if (session.status === 'error') state = 'error';
                else if (session.isStreaming) state = 'live';
                else state = 'connecting';
            }
            else if (now - (e.lastAliveAt ?? 0) < BackgroundManager.LEASE_STALE_MS) {
                state = 'elsewhere';
            }
            else {
                state = 'suspended';
            }
            chips.push({ key, name: e.friendlyName || e.entity || key, state });
        }
        return chips;
    }

    // ------------------------------------------------------------------ page lifecycle

    installLifecycleHandlers() {
        const suspend = () => {
            for (const session of WebRTCsession.sessions.values()) {
                if (session.ownerWindow !== window) continue;
                if (session.background && session.state.cards.size > 0) this.releaseLease(session.key);
                // Synchronous teardown: an awaited teardown never completes in pagehide and
                // leaves the go2rtc socket to time out server-side. Iterate ALL calls, not
                // just activeCall - an in-flight connecting call is registered in
                // state.calls but not yet active.
                for (const call of [...session.state.calls.values()]) {
                    session.endCallFast(call);
                }
            }
            this.stopTicker();
        };
        window.addEventListener('pagehide', suspend);
        window.addEventListener('pageshow', ev => {
            if (ev.persisted) this.resumeSessions();
        });
        if ('onfreeze' in document) {              // Page Lifecycle API (Chromium)
            document.addEventListener('freeze', suspend);
            document.addEventListener('resume', () => this.resumeSessions());
        }
        document.addEventListener('visibilitychange', () => {
            this.updateTicker();
            this.refreshDockThrottled();
        });
    }

    resumeSessions() {
        for (const session of WebRTCsession.sessions.values()) {
            if (session.ownerWindow !== window) continue;
            if (session.state.cards.size === 0 || session.isTerminated) continue;
            if (session.background) this.noteAlive(session.key);
            session.lastTickDate = 0;              // a frozen gap is not starvation evidence
            session.relieveVideoPressure?.(true);
            session.timeoutCall?.(session.activeCall);
            session.kick?.();
        }
        this.refreshDock();
    }

    // ------------------------------------------------------------------ throttling-proof ticker

    updateTicker() {
        let needed = false;
        try {
            needed = document.hidden === true && [...WebRTCsession.sessions.values()].some(s =>
                s.ownerWindow === window && s.background && s.state.cards.size > 0 && !s.isTerminated);
        } catch { }
        if (needed) {
            this.startTicker();
            this.acquireKeepAliveLock();
        } else {
            this.stopTicker();
            this.releaseKeepAliveLock();
        }
    }

    acquireKeepAliveLock() {
        // Chromium's Energy Saver freezes hidden+silent tabs after 5 minutes; a held Web
        // Lock is a documented exemption. Web Locks is secure-context-only, so this is a
        // best-effort extra on https installs - the worker ticker remains the primary
        // fail-safe on plain-http HA.
        //
        // Grants arrive as a LATER task, never within the requesting task, and updateTicker
        // runs several times per visibilitychange dispatch - so an explicit pending flag is
        // required: guarding only on the release resolver would issue duplicate requests
        // whose second grant overwrites the first resolver, permanently leaking a held lock.
        this._keepAliveLockAbandoned = false;      // re-acquire while pending keeps the grant
        if (this._keepAliveLockRelease || this._keepAliveLockPending) return;
        try {
            if (!window.isSecureContext || !navigator.locks?.request) return;
            this._keepAliveLockPending = true;
            navigator.locks.request('webrtc-babycam:keepalive', { mode: 'shared' },
                () => new Promise(resolve => {
                    this._keepAliveLockPending = false;
                    if (this._keepAliveLockAbandoned) {
                        // released while the grant was in flight (hide->show race)
                        this._keepAliveLockAbandoned = false;
                        resolve();
                        return;
                    }
                    this._keepAliveLockRelease = resolve;
                })
            ).catch(() => {
                this._keepAliveLockPending = false;
                this._keepAliveLockRelease = null;
            });
        } catch {
            this._keepAliveLockPending = false;
        }
    }

    releaseKeepAliveLock() {
        if (this._keepAliveLockPending) this._keepAliveLockAbandoned = true;
        try { this._keepAliveLockRelease?.(); } catch { }
        this._keepAliveLockRelease = null;
    }

    startTicker() {
        if (this.tickerWorker || typeof Worker === 'undefined') return;
        try {
            // Dedicated-worker timers are exempt from hidden-page timer throttling; this is
            // the metronome that keeps lease heartbeats and reconnect attempts flowing when
            // main-thread timers degrade to one per minute (intensive throttling applies
            // exactly during reconnect gaps: no live MediaStreamTrack, no audible audio).
            const src = `setInterval(() => postMessage(0), ${BackgroundManager.TICKER_INTERVAL_MS});`;
            this.tickerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            this.tickerWorker = new Worker(this.tickerUrl);
            this.tickerWorker.onmessage = () => this.onWorkerTick();
        } catch {
            // CSP may block blob workers: accept main-thread cadence (starvation-aware
            // watchdog still prevents false teardowns; recovery just runs slower).
            this.stopTicker();
        }
    }

    stopTicker() {
        try { this.tickerWorker?.terminate(); } catch { }
        this.tickerWorker = null;
        if (this.tickerUrl) {
            try { URL.revokeObjectURL(this.tickerUrl); } catch { }
            this.tickerUrl = null;
        }
    }

    onWorkerTick() {
        const now = Date.now();
        for (const session of WebRTCsession.sessions.values()) {
            if (session.ownerWindow !== window || session.isTerminated) continue;
            if (!(session.background && session.state.cards.size > 0)) continue;
            this.noteAlive(session.key);
            if (now - (session.lastTickDate || 0) > BackgroundManager.WATCHDOG_OVERDUE_MS) {
                session.kick();
            }
        }
    }

    // ------------------------------------------------------------------ media session

    updateMediaSession() {
        if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
        let active = null;
        try {
            // A session parked by the OS pause button ('user') stays "active" in the
            // paused state, so the lock-screen surface that parked it survives to resume it.
            active = [...WebRTCsession.sessions.values()].find(s =>
                s.ownerWindow === window && s.background && !s.isTerminated
                && s.state.cards.size > 0
                && (s.parked === 'user'
                    || [...s.state.cards].some(c => c.media && !c.media.muted && c.isPlaying)));
        } catch { }
        try {
            if (!active) {
                if (this.mediaSessionKey) {
                    navigator.mediaSession.metadata = null;
                    navigator.mediaSession.playbackState = 'none';
                    this.mediaSessionKey = null;
                }
                return;
            }
            const desiredState = active.parked === 'user' ? 'paused' : 'playing';
            if (this.mediaSessionKey === active.key) {
                navigator.mediaSession.playbackState = desiredState;
                return;
            }
            this.mediaSessionKey = active.key;
            const e = this.entry(active.key);
            navigator.mediaSession.metadata = new MediaMetadata({
                title: e?.friendlyName ?? active.config.entity,
                artist: 'WebRTC Babycam'
            });
            navigator.mediaSession.playbackState = desiredState;
            // Action handlers run with user activation, so 'play' can legally re-unmute.
            navigator.mediaSession.setActionHandler('play', () => {
                WebRTCsession.enableUnmute();
                const s = WebRTCsession.sessions.get(this.mediaSessionKey);
                s?.unpark?.();
                s?.kick?.();
                try { navigator.mediaSession.playbackState = 'playing'; } catch { }
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                // OS pause on a background stream = park loudly (resumable), instead of
                // the browser-default pause fighting the card's auto-resume loop.
                const s = WebRTCsession.sessions.get(this.mediaSessionKey);
                if (s?.shouldKeepBackgroundAudio) {
                    s.park('user');
                    try { navigator.mediaSession.playbackState = 'paused'; } catch { }
                }
            });
        } catch { }
    }

    // ------------------------------------------------------------------ dock lifecycle

    ensureDock() {
        // The dock element class is per-realm; create it in this script's own document
        // (HA loads card resources in the top document, which is the intended home).
        const doc = document;
        if (this.dock && this.dock.isConnected) return;
        const body = doc.body;
        if (!body) return;                          // heartbeatTick retries
        try {
            let dock = body.querySelector(':scope > webrtc-babycam-dock');
            if (!dock) {
                dock = doc.createElement('webrtc-babycam-dock');
                body.appendChild(dock);
            }
            this.dock = dock;
        } catch { }
    }

    refreshDock() {
        this.updateMediaSession();
        this.updateTicker();
        try { this.dock?.refresh?.(); } catch { }
    }

    refreshDockThrottled() {
        if (this.dockRefreshTimeoutId) return;
        this.dockRefreshTimeoutId = setTimeout(() => {
            this.dockRefreshTimeoutId = undefined;
            this.refreshDock();
        }, 250);
    }
}

/**
 * <webrtc-babycam-dock> - the minimized surface for background sessions.
 *
 * A small fixed pill (bottom-center, safe-area aware) that exists only while at least one
 * background session is active and its card is not on screen. Expanding it lists each
 * session with its live state and two actions: RETURN (navigate back to the card's
 * dashboard view) and CLOSE (stop the background stream, with a 5s UNDO). A row in the
 * 'blocked' state turns the tap itself into the autoplay-unmute gesture. The dock never
 * plays sound, never shifts layout, and is suppressed while anything is fullscreen.
 */
class WebRTCbabycamDock extends HTMLElement {
    static UNDO_TIMEOUT_MS = 5000;
    static COLLAPSE_TIMEOUT_MS = 15000;

    static STATE_TEXT = {
        live: 'Live audio · tap to open',
        connecting: 'Connecting…',
        blocked: 'Audio blocked — tap to enable',
        expired: 'Paused — tap to resume',
        error: 'Reconnecting… · tap to open',
        elsewhere: 'Playing in another tab',
        suspended: 'Tap to open'
    };

    constructor() {
        super();
        this.rendered = false;
        this.undo = null;                          // { key, name, timerId }
        this.collapseTimeoutId = undefined;
        this.outsidePointerDown = this.outsidePointerDown.bind(this);
        this.fullscreenEvent = this.fullscreenEvent.bind(this);
    }

    connectedCallback() {
        if (!this.rendered) {
            this.render();
            this.rendered = true;
        }
        this.ownerDocument.addEventListener('fullscreenchange', this.fullscreenEvent);
        this.refresh();
    }

    disconnectedCallback() {
        this.ownerDocument.removeEventListener('fullscreenchange', this.fullscreenEvent);
        this.ownerDocument.removeEventListener('pointerdown', this.outsidePointerDown, true);
        clearTimeout(this.collapseTimeoutId);
        this.collapseTimeoutId = undefined;
    }

    render() {
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.innerHTML = `
        <style>
            :host {
                position: fixed;
                left: 50%;
                transform: translateX(-50%);
                bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
                z-index: var(--webrtc-babycam-dock-z-index, 6); /* below HA dialogs (8) */
                font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
                color: var(--primary-text-color, #212121);
                display: none;
                pointer-events: none;
                max-width: min(360px, calc(100vw - 32px));
            }
            :host([active]) { display: block; }
            :host([suppressed]) { display: none; }
            .chip, .panel {
                pointer-events: auto;
                background: var(--card-background-color, var(--ha-card-background, #fff));
                color: var(--primary-text-color, #212121);
                box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.28));
                border: 1px solid var(--divider-color, rgba(0,0,0,.12));
            }
            .chip {
                display: flex; align-items: center; gap: 8px;
                height: 40px; padding: 0 14px;
                border-radius: 20px;
                cursor: pointer; user-select: none;
                font-size: 13px;
            }
            :host([expanded]) .chip { display: none; }
            .chip svg { width: 18px; height: 18px; fill: var(--primary-color, #03a9f4); }
            .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: gray; }
            .dot[state="live"]       { background: var(--success-color, #0f9d58);
                                       animation: dockPulse 2s ease-in-out infinite; }
            .dot[state="connecting"] { background: var(--secondary-text-color, #727272);
                                       animation: dockPulse 1s ease-in-out infinite; }
            .dot[state="blocked"], .dot[state="expired"] { background: var(--warning-color, #ffa600); }
            .dot[state="error"]      { background: var(--error-color, #db4437); }
            .dot[state="elsewhere"]  { background: var(--info-color, #4285f4); }
            .dot[state="suspended"]  { background: var(--secondary-text-color, #727272); }
            @keyframes dockPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
            @media (prefers-reduced-motion: reduce) {
                .dot { animation: none !important; }
            }
            .panel { display: none; padding: 4px 0; border-radius: 16px; }
            :host([expanded]) .panel { display: block; }
            .row {
                display: flex; align-items: center; gap: 10px;
                min-height: 48px; padding: 0 8px 0 16px;
                cursor: pointer;
            }
            .row + .row, .undo + .row, .row + .undo { border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
            .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                    white-space: nowrap; font-size: 14px; }
            .sub  { display: block; font-size: 11px; color: var(--secondary-text-color, #727272); }
            .row[state="blocked"] .sub, .row[state="expired"] .sub { color: var(--warning-color, #ffa600); }
            .row[state="error"] .sub { color: var(--error-color, #db4437); }
            .iconbtn {
                width: 44px; height: 44px; flex: none;
                display: flex; align-items: center; justify-content: center;
                border-radius: 50%; cursor: pointer;
            }
            .iconbtn svg { width: 20px; height: 20px; fill: var(--secondary-text-color, #727272); }
            .iconbtn:hover { background: rgba(127,127,127,.12); }
            .undo {
                display: flex; align-items: center; gap: 10px;
                min-height: 40px; padding: 0 16px; font-size: 13px;
            }
            .undo button {
                all: unset; cursor: pointer; font-weight: 500;
                color: var(--primary-color, #03a9f4); padding: 8px;
            }
        </style>
        <div class="chip" part="chip" role="button" tabindex="0" aria-label="Background cameras" title="WebRTC Babycam v${CARD_VERSION}">
            <svg viewBox="0 0 24 24"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z"/></svg>
            <span class="count"></span>
            <span class="dot"></span>
        </div>
        <div class="panel" role="list"></div>`;

        this.shadowRoot.querySelector('.chip').addEventListener('click', () => this.expand(true));
        this.shadowRoot.querySelector('.panel').addEventListener('click', ev => this.panelClick(ev));
    }

    static escape(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    expand(on) {
        clearTimeout(this.collapseTimeoutId);
        this.collapseTimeoutId = undefined;
        if (on) {
            this.setAttribute('expanded', '');
            this.ownerDocument.addEventListener('pointerdown', this.outsidePointerDown, true);
            this.collapseTimeoutId = setTimeout(() => this.expand(false), WebRTCbabycamDock.COLLAPSE_TIMEOUT_MS);
        } else {
            this.removeAttribute('expanded');
            this.ownerDocument.removeEventListener('pointerdown', this.outsidePointerDown, true);
        }
    }

    outsidePointerDown(ev) {
        if (ev.composedPath().includes(this)) return;
        this.expand(false);
    }

    fullscreenEvent() {
        this.toggleAttribute('suppressed', !!this.ownerDocument.fullscreenElement);
    }

    panelClick(ev) {
        const actionEl = ev.target.closest('[data-action]');
        if (!actionEl) return;
        const key = actionEl.closest('[data-key]')?.dataset.key;
        if (!key) return;
        const manager = BackgroundManager.getInstance();
        try {
            switch (actionEl.dataset.action) {
                case 'return':
                    manager.dockReturn(key);
                    this.expand(false);
                    break;
                case 'resume':
                    manager.dockResume(key);
                    break;
                case 'close':
                    this.armUndo(key);
                    manager.dockClose(key);
                    break;
                case 'undo':
                    this.clearUndo();
                    manager.dockUndo(key);
                    break;
            }
        } catch (err) {
            // dock failures must never propagate into session/watchdog code
            console.warn('webrtc-babycam-dock action failed', err);
        }
        this.refresh();
    }

    armUndo(key) {
        this.clearUndo(true);                      // finalize any previous pending close first
        const entry = BackgroundManager.getInstance().entry(key);
        const timerId = setTimeout(() => {
            if (this.undo?.key === key) {
                this.undo = null;
                // Undo window elapsed without an undo: commit the close as a full unpin.
                try { BackgroundManager.getInstance().dockCloseFinal(key); } catch { }
            }
            this.refresh();
        }, WebRTCbabycamDock.UNDO_TIMEOUT_MS);
        this.undo = { key, name: entry?.friendlyName || entry?.entity || key, timerId };
    }

    clearUndo(finalize = false) {
        if (!this.undo) return;
        clearTimeout(this.undo.timerId);
        if (finalize) {
            const key = this.undo.key;
            try { BackgroundManager.getInstance().dockCloseFinal(key); } catch { }
        }
        this.undo = null;
    }

    refresh() {
        if (!this.rendered) return;
        const manager = BackgroundManager.getInstance();
        // A key with a pending close (undo window) is represented by the undo strip alone.
        const chips = manager.snapshot().filter(c => c.key !== this.undo?.key);
        const active = chips.length > 0 || !!this.undo;

        this.toggleAttribute('active', active);
        if (!active) {
            this.expand(false);
            return;
        }

        const order = ['error', 'blocked', 'expired', 'connecting', 'elsewhere', 'suspended', 'live'];
        const worst = order.find(s => chips.some(c => c.state === s)) ?? 'live';
        const count = this.shadowRoot.querySelector('.chip .count');
        count.textContent = chips.length > 1 ? `${chips.length} cameras` : (chips[0]?.name ?? '');
        this.shadowRoot.querySelector('.chip .dot').setAttribute('state', worst);

        const esc = WebRTCbabycamDock.escape;
        const openGlyph = '<svg viewBox="0 0 24 24"><path d="M12,10L8,14H11V20H13V14H16M19,4H5C3.89,4 3,4.9 3,6V18A2,2 0 0,0 5,20H9V18H5V8H19V18H15V20H19A2,2 0 0,0 21,18V6A2,2 0 0,0 19,4Z"/></svg>';
        const closeGlyph = '<svg viewBox="0 0 24 24"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>';

        let html = chips.map(c => {
            const bodyAction = (c.state === 'blocked' || c.state === 'expired') ? 'resume' : 'return';
            return `
            <div class="row" role="listitem" data-key="${esc(c.key)}" state="${esc(c.state)}">
                <span class="dot" state="${esc(c.state)}"></span>
                <span class="name" data-action="${bodyAction}">${esc(c.name)}
                    <span class="sub">${WebRTCbabycamDock.STATE_TEXT[c.state] ?? ''}</span></span>
                <span class="iconbtn" data-action="return" title="Open camera view" role="button">${openGlyph}</span>
                <span class="iconbtn" data-action="close" title="Stop background stream" role="button">${closeGlyph}</span>
            </div>`;
        }).join('');

        if (this.undo) {
            html += `
            <div class="undo" data-key="${esc(this.undo.key)}">
                <span class="name">${esc(this.undo.name)} stopped</span>
                <button data-action="undo">UNDO</button>
            </div>`;
        }

        this.shadowRoot.querySelector('.panel').innerHTML = html;

        if (this.undo && !this.hasAttribute('expanded')) {
            this.expand(true);                     // keep the UNDO reachable
        }
    }
}

if (!customElements.get('webrtc-babycam-dock')) customElements.define('webrtc-babycam-dock', WebRTCbabycamDock);

// Boot the manager at SCRIPT LOAD, not first card connect: after a reload the current
// dashboard may contain no babycam card, yet the dock must still offer the pinned
// sessions ('suspended' chips) for return/reopen.
try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => BackgroundManager.getInstance(), { once: true });
    } else {
        BackgroundManager.getInstance();
    }
} catch (err) {
    console.warn('webrtc-babycam: background manager init failed', err);
}
// ---------------------------------------------------------------------------
// Remote fullscreen overlay — driven by the Babycam custom integration.
// `babycam.open` / `babycam.close` service calls fire `babycam_open` /
// `babycam_close` events on the HA bus; every browser that has this resource
// loaded (resource-loader puts it on all dashboards) shows/hides a fullscreen
// webrtc-babycam overlay. Replaces browser_mod popups: true 100% viewport
// height, above all app chrome. Clicking the overlay closes it locally
// (matching the old popup's click_close behavior); the service close removes
// it everywhere.
// ---------------------------------------------------------------------------
(function () {
    const OVERLAY_ID = 'babycam-remote-overlay';
    let overlay = null;
    let hassPump = null;

    function getHass() {
        return document.querySelector('home-assistant')?.hass;
    }

    let overlayOnClose = null;

    function closeOverlay() {
        if (hassPump) { clearInterval(hassPump); hassPump = null; }
        if (overlay) { overlay.remove(); overlay = null; }
        const cb = overlayOnClose;
        overlayOnClose = null;
        try { cb?.(); } catch { }
    }

    function openOverlay(config, opts) {
        closeOverlay();
        if (!config || !config.entity) return;

        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        // touch-action:none — the overlay owns ALL touch gestures (swipe-to-close);
        // without it the webview claims drags for scrolling and swipes never land.
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:2147483000;background:#000;' +
            'display:flex;align-items:center;justify-content:center;' +
            'touch-action:none;overscroll-behavior:none;';

        const card = document.createElement('webrtc-babycam');
        card.style.cssText = 'width:100%;height:100%;touch-action:none;';
        // The overlay is a STAGE, not a tile: drop the per-card aspect_ratio
        // (which locks a cover-cropped, top-anchored box sized for the grid)
        // and frame the media at its OWN aspect ratio, centered. `fit` picks
        // the axis the media must fill (overflow on the other axis is clipped
        // symmetrically from the center): 'both' (default) letterboxes like
        // the native player; 'width' fills the width and crops top/bottom;
        // 'height' fills the height and crops the sides. object-fit cannot
        // express per-axis fill, so width/height set element geometry
        // directly. Rides the user style: mechanism, which injects after the
        // card's own sizing rules.
        const stageConfig = { ...config };
        delete stageConfig.aspect_ratio;
        const fit = String(stageConfig.fit ?? 'both').toLowerCase();
        delete stageConfig.fit;
        const stageRules = WebRTCbabycam.fitRules(fit);
        stageConfig.style = (stageConfig.style ? stageConfig.style + '\n' : '') +
            'video, .image {' + stageRules + ' }' +
            ' ha-card, .media-container { overflow: hidden !important; }';
        try {
            card.setConfig(stageConfig);
        } catch (err) {
            console.warn('babycam overlay: bad config', err);
            overlay = null;
            return;
        }
        card.hass = getHass();
        overlay.appendChild(card);

        // click_close parity with the old browser_mod popup
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) closeOverlay();
        });

        // armed only after a successful mount: a bad-config bail above must
        // not leave a stale callback for a future close
        overlayOnClose = opts?.onclose ?? null;
        document.body.appendChild(overlay);

        // keep the card's hass reference fresh while the overlay lives
        hassPump = setInterval(() => {
            const h = getHass();
            if (h && overlay) card.hass = h;
        }, 1000);
    }

    async function subscribe() {
        // wait for the frontend's hass connection (resource loads early)
        for (let i = 0; i < 240; i++) {
            const conn = getHass()?.connection;
            if (conn) {
                // Component-owned subscription command: non-admin users (wallpanels)
                // cannot subscribe to arbitrary bus events, so the babycam component
                // forwards open/close through babycam/subscribe (auth, not admin).
                // subscribeMessage re-subscribes automatically on reconnect.
                conn.subscribeMessage(
                    (msg) => {
                        if (msg?.event_type === 'babycam_open') openOverlay(msg.data || {});
                        else if (msg?.event_type === 'babycam_close') closeOverlay();
                    },
                    { type: 'babycam/subscribe' }
                ).catch((err) => console.warn('babycam overlay: subscribe failed', err));
                return;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        console.warn('babycam overlay: no hass connection; remote open/close inactive');
    }
    subscribe();

    // Pinned background streams survive page (re)loads: rebuild their
    // sessions from the registry's stored configs (see BackgroundManager.
    // resurrectSuspendedSessions — no-op when every pin has a session).
    BackgroundManager.getInstance().resurrectSuspendedSessions();

    // Card gesture verbs ('close' in fullscreen context, local 'fullscreen'
    // escalation) need programmatic access to the overlay.
    window.babycamOverlay = { open: openOverlay, close: closeOverlay };

    // LOCAL open from any dashboard card (this browser only — unlike the
    // babycam.open service, which broadcasts to every browser):
    //   tap_action:
    //     action: fire-dom-event
    //     babycam: { url: ..., entity: camera.x, ... }   # card config
    // fire-dom-event dispatches 'll-custom' with the action object as detail.
    // { babycam: "close" } (or {action: 'close'}) closes instead.
    window.addEventListener('ll-custom', (ev) => {
        const cfg = ev.detail?.babycam;
        if (!cfg) return;
        if (cfg === 'close' || cfg.action === 'close') closeOverlay();
        else openOverlay(cfg);
    });
})();
