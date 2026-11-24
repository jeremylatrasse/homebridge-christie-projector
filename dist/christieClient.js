"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChristieClient = void 0;
exports.validateChristieHost = validateChristieHost;
const dgram = __importStar(require("node:dgram"));
const node_events_1 = require("node:events");
const net = __importStar(require("node:net"));
/**
 * Christie Digital Serial / TCP Protocol Client (Default Port 3002).
 *
 * Implements the full Christie ASCII parenthesized command protocol:
 * - Commands: `(CMD <value>)\r\n` or `(CMD+SUB <value>)\r\n`
 * - Queries:  `(CMD?)\r\n` or `(CMD+SUB?)\r\n`
 * - Replies:  `(CMD!<value>)` or `(CMD!<value> "<description>")`
 */
/**
 * Validates that an IPv4 address has exactly 4 octets between 0 and 255.
 * Also permits standard RFC 1123 hostnames (e.g. christie.local).
 */
function validateChristieHost(host) {
    if (typeof host !== 'string' || !host.trim()) {
        return { valid: false, reason: 'Host is empty or undefined.' };
    }
    const trimmed = host.trim();
    // If host contains only digits and dots, it is an IPv4 address attempt
    if (/^[0-9.]+$/.test(trimmed)) {
        const octets = trimmed.split('.');
        if (octets.length !== 4) {
            return {
                valid: false,
                reason: `Invalid IPv4 address '${trimmed}': an IPv4 address must contain exactly 4 octets (found ${octets.length}). Example: 172.16.1.247`,
            };
        }
        for (let i = 0; i < octets.length; i++) {
            const octet = octets[i];
            if (octet === '' || isNaN(Number(octet))) {
                return {
                    valid: false,
                    reason: `Invalid IPv4 address '${trimmed}': octet #${i + 1} is empty or non-numeric.`,
                };
            }
            const num = Number(octet);
            if (num < 0 || num > 255) {
                return {
                    valid: false,
                    reason: `Invalid IPv4 address '${trimmed}': octet #${i + 1} ('${octet}') is out of range 0-255.`,
                };
            }
            if (octet.length > 1 && octet.startsWith('0')) {
                return {
                    valid: false,
                    reason: `Invalid IPv4 address '${trimmed}': octet #${i + 1} ('${octet}') cannot have leading zeroes.`,
                };
            }
        }
        return { valid: true };
    }
    // Otherwise hostname / FQDN validation:
    const parts = trimmed.split('.');
    if (parts.some((p) => p.length === 0)) {
        return { valid: false, reason: `Invalid hostname '${trimmed}': consecutive or trailing dots.` };
    }
    const lastPart = parts[parts.length - 1];
    if (/^[0-9]+$/.test(lastPart)) {
        return {
            valid: false,
            reason: `Invalid host '${trimmed}': looks like an incomplete IPv4 address with ${parts.length} octets. IPv4 addresses must have exactly 4 octets.`,
        };
    }
    return { valid: true };
}
class ChristieClient extends node_events_1.EventEmitter {
    log;
    socket = null;
    isConnecting = false;
    isDestroyed = false;
    buffer = '';
    commandQueue = [];
    reconnectTimer;
    pollTimer;
    transitionTimer;
    connectTimeoutTimer;
    initialPollTimer;
    deferredPowerOnTimer;
    deferredPowerOnPending = false;
    powerTransitionTarget = null;
    powerTransitionUntil = 0;
    lastPowerOffAt = 0;
    cooldownUntil = 0;
    cooldownLoggedForCycle = false;
    cooldownQueryAttemptedForCycle = false;
    cooldownQuerySupported = null;
    pendingPowerOnCommand = null;
    pendingPowerOnRetries = 0;
    lastPowerOnWriteAt = 0;
    awaitingResponse = false;
    lastDataReceivedAt = 0;
    lastProbeSentAt = 0;
    heartbeatActive = false;
    expectedPowerState = 'off';
    heartbeatLogState = 'logged-failure';
    onCommandSentAt = 0;
    config;
    state = {
        power: false,
        powerStatus: 'OFF',
        rawPowerCode: null,
        cooldownRemainingSeconds: 0,
        shutterClosed: false,
        freeze: false,
        osd: true,
        pip: false,
        currentInput: 1,
        currentChannel: 1,
        currentTestPattern: 0,
        currentLensMemory: 1,
        currentSizeMode: 1,
        lightPower: 100,
        brightness: 50,
        contrast: 50,
        sharpness: 50,
        colorSaturation: 50,
        gamma: 0,
        zoom: 0,
        focus: 0,
        lensHorizontalShift: 0,
        lensVerticalShift: 0,
        keystone: 0,
        warpMap: 0,
        edgeBlend: 0,
        lampHours: null,
        model: null,
        serialNumber: null,
        firmware: null,
        customStates: new Map(),
    };
    constructor(config, log) {
        super();
        this.log = log;
        const validation = validateChristieHost(config.host);
        if (!validation.valid) {
            this.log.error(`[${config.host}] ${validation.reason}`);
            throw new Error(`[ChristieClient] ${validation.reason}`);
        }
        const parsedCooldown = config.cooldownGraceSeconds !== undefined ? Number(config.cooldownGraceSeconds) : 60;
        const cooldownGraceSeconds = Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? parsedCooldown : 60;
        this.config = {
            host: config.host,
            port: config.port || 3002,
            mac: config.mac || '',
            pollInterval: config.pollInterval || 10,
            reconnectInterval: config.reconnectInterval || 5,
            socketTimeoutMs: config.socketTimeoutMs || 3000,
            cooldownGraceSeconds,
            treatCode10AsOn: config.treatCode10AsOn !== undefined ? config.treatCode10AsOn : true,
            inputCommandType: config.inputCommandType || 'SIN',
            onCommand: (typeof config.onCommand === 'string' ? config.onCommand.trim() : '') || '(PWR 1)',
            offCommand: (typeof config.offCommand === 'string' ? config.offCommand.trim() : '') || '(PWR 0)',
            stateCommand: (typeof config.stateCommand === 'string' ? config.stateCommand.trim() : '') || '(PWR?)',
        };
    }
    start() {
        this.isDestroyed = false;
        // Heartbeat probing only begins once an ON command is sent
    }
    stop() {
        this.isDestroyed = true;
        this.heartbeatActive = false;
        this.deferredPowerOnPending = false;
        this.clearTimers();
        this.disconnect();
    }
    restart() {
        this.log.info(`[${this.config.host}] Restarting Christie projector client connection...`);
        this.stop();
        this.isDestroyed = false;
        this.beginHeartbeatProbing();
    }
    clearTimers() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.transitionTimer) {
            clearInterval(this.transitionTimer);
            this.transitionTimer = undefined;
        }
        if (this.connectTimeoutTimer) {
            clearTimeout(this.connectTimeoutTimer);
            this.connectTimeoutTimer = undefined;
        }
        if (this.initialPollTimer) {
            clearTimeout(this.initialPollTimer);
            this.initialPollTimer = undefined;
        }
        if (this.deferredPowerOnTimer) {
            clearTimeout(this.deferredPowerOnTimer);
            this.deferredPowerOnTimer = undefined;
        }
    }
    clearTransitionTimer() {
        if (this.transitionTimer) {
            clearInterval(this.transitionTimer);
            this.transitionTimer = undefined;
        }
    }
    isCooldownActive() {
        return this.cooldownUntil > Date.now();
    }
    getRemainingCooldownMs() {
        return Math.max(0, this.cooldownUntil - Date.now());
    }
    isPowerOnDeferred() {
        return this.deferredPowerOnPending;
    }
    beginHeartbeatProbing() {
        this.heartbeatActive = true;
        this.expectedPowerState = 'on';
        this.heartbeatLogState = 'awaiting-success';
        this.onCommandSentAt = Date.now();
        this.startPolling();
        this.connect();
    }
    recordHeartbeatSuccess() {
        if (!this.heartbeatActive) {
            return;
        }
        if (this.heartbeatLogState !== 'logged-success') {
            if (this.expectedPowerState === 'off') {
                this.log.info(`[${this.config.host}] Heartbeat succeeded (unexpected state change while in OFF state) — unit is online.`);
                this.expectedPowerState = 'on';
            }
            else {
                this.log.info(`[${this.config.host}] Heartbeat succeeded — unit is online and responding.`);
            }
            this.heartbeatLogState = 'logged-success';
        }
    }
    recordHeartbeatFailure() {
        if (!this.heartbeatActive) {
            return;
        }
        if (this.expectedPowerState === 'off') {
            if (this.heartbeatLogState !== 'logged-failure') {
                this.log.info(`[${this.config.host}] Heartbeat failed as expected in OFF state — quietly probing until next ON command or state change.`);
                this.heartbeatLogState = 'logged-failure';
            }
        }
        else {
            const bootGraceExpired = this.heartbeatLogState === 'awaiting-success' &&
                this.onCommandSentAt > 0 &&
                Date.now() - this.onCommandSentAt > this.config.cooldownGraceSeconds * 1000;
            if (this.heartbeatLogState === 'logged-success' || bootGraceExpired) {
                this.log.warn(`[${this.config.host}] Heartbeat failed in ON state — quietly probing until next ON command or state change.`);
                this.heartbeatLogState = 'logged-failure';
            }
        }
    }
    isConnected() {
        return this.socket !== null && !this.socket.destroyed && !this.isConnecting;
    }
    /**
     * Formats a Christie ASCII command ensuring enclosing parentheses `(...)`.
     */
    static formatCommand(rawCommand) {
        const trimmed = rawCommand.trim();
        if (!trimmed) {
            return '';
        }
        if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
            return trimmed;
        }
        return `(${trimmed})`;
    }
    /**
     * Sends a one-shot query/command over a dedicated short-lived TCP connection
     * (equivalent to `printf '(PWR?)\r\n' | nc -w 3 <host> 3002`) and resolves with the reply.
     */
    sendOneShot(rawCommand, timeoutMs = this.config.socketTimeoutMs) {
        const formatted = ChristieClient.formatCommand(rawCommand);
        return new Promise((resolve) => {
            const client = new net.Socket();
            let settled = false;
            let rxData = '';
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    client.removeAllListeners();
                    client.destroy();
                }
                catch {
                    // ignore
                }
                if (rxData.trim().length > 0) {
                    this.handleIncomingData(rxData);
                }
                resolve(rxData.trim());
            };
            client.setTimeout(timeoutMs);
            client.on('connect', () => {
                client.write(`${formatted}\r\n`);
            });
            client.on('data', (chunk) => {
                rxData += chunk.toString('utf8');
                if (rxData.includes(')') || rxData.includes('\n')) {
                    finish();
                }
            });
            client.on('timeout', () => finish());
            client.on('error', () => finish());
            client.on('close', () => finish());
            client.connect(this.config.port, this.config.host);
        });
    }
    /**
     * Actively probes whether the Christie projector is responding on port 3002.
     */
    async checkIfResponding(timeoutMs = this.config.socketTimeoutMs) {
        const response = await this.sendOneShot(this.config.stateCommand, timeoutMs);
        return response.length > 0;
    }
    // --- Connection Management ---
    connect() {
        if (this.isDestroyed || !this.heartbeatActive || this.socket || this.isConnecting) {
            return;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.isConnecting = true;
        this.awaitingResponse = true;
        this.log.debug(`[${this.config.host}] Connecting to Christie Projector at ${this.config.host}:${this.config.port}...`);
        const socket = new net.Socket();
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
        socket.setTimeout(Math.max(15000, this.config.pollInterval * 2000));
        if (this.connectTimeoutTimer) {
            clearTimeout(this.connectTimeoutTimer);
        }
        this.connectTimeoutTimer = setTimeout(() => {
            this.connectTimeoutTimer = undefined;
            if (this.isConnecting) {
                if (this.powerTransitionTarget !== null && Date.now() < this.powerTransitionUntil) {
                    this.log.warn(`[${this.config.host}:${this.config.port}] TCP connect timed out while sending power ${this.powerTransitionTarget ? 'ON' : 'OFF'}.`);
                }
                else {
                    this.log.debug(`[${this.config.host}] Connect attempt timed out`);
                }
                this.handleSocketClose();
            }
        }, 5000);
        socket.on('connect', () => {
            if (this.connectTimeoutTimer) {
                clearTimeout(this.connectTimeoutTimer);
                this.connectTimeoutTimer = undefined;
            }
            this.isConnecting = false;
            this.lastProbeSentAt = Date.now();
            this.log.debug(`[${this.config.host}] TCP connected to Christie Projector on port ${this.config.port}`);
            const hadQueuedCommands = this.commandQueue.length > 0;
            // Flush any commands queued while connecting
            while (this.commandQueue.length > 0) {
                const nextCmd = this.commandQueue.shift();
                this.writeToSocket(nextCmd);
            }
            // Defer initial status polling slightly when a queued command (such as (PWR 1))
            // was just flushed so it is sent cleanly in its own TCP packet rather than
            // coalesced with (PWR?)/(SHU?)/(SIN?)/(FRZ?) queries.
            if (hadQueuedCommands) {
                if (this.initialPollTimer) {
                    clearTimeout(this.initialPollTimer);
                }
                this.initialPollTimer = setTimeout(() => {
                    this.initialPollTimer = undefined;
                    if (!this.isDestroyed && this.isConnected()) {
                        this.pollStatus();
                    }
                }, 150);
            }
            else {
                this.pollStatus();
            }
        });
        socket.on('data', (data) => {
            this.handleIncomingData(data.toString('utf8'));
        });
        socket.on('timeout', () => {
            if (this.isConnecting || !this.state.power) {
                this.log.debug(`[${this.config.host}] Socket timeout while in standby/connecting — closing socket`);
                this.handleSocketClose();
                return;
            }
            this.log.debug(`[${this.config.host}] Socket idle timeout — polling power status...`);
            this.lastProbeSentAt = Date.now();
            this.queryPower();
        });
        socket.on('error', (err) => {
            if (this.powerTransitionTarget !== null && Date.now() < this.powerTransitionUntil) {
                this.log.warn(`[${this.config.host}:${this.config.port}] TCP error during power ${this.powerTransitionTarget ? 'ON' : 'OFF'}: ${err.message}`);
            }
            else {
                this.log.debug(`[${this.config.host}] Socket error: ${err.message}`);
            }
        });
        socket.on('close', (hadError) => {
            this.log.debug(`[${this.config.host}] Socket closed (hadError: ${hadError})`);
            this.handleSocketClose();
        });
        socket.connect(this.config.port, this.config.host);
    }
    disconnect() {
        if (this.connectTimeoutTimer) {
            clearTimeout(this.connectTimeoutTimer);
            this.connectTimeoutTimer = undefined;
        }
        if (this.initialPollTimer) {
            clearTimeout(this.initialPollTimer);
            this.initialPollTimer = undefined;
        }
        if (this.socket) {
            const sock = this.socket;
            this.socket = null;
            try {
                sock.removeAllListeners();
                sock.end();
                sock.destroy();
            }
            catch {
                // ignore errors on tear-down
                try {
                    sock.destroy();
                }
                catch {
                    // ignore
                }
            }
        }
        this.isConnecting = false;
        this.awaitingResponse = false;
        this.lastProbeSentAt = 0;
    }
    handleSocketClose() {
        const prevPower = this.state.power;
        const withinPowerOnGrace = (this.powerTransitionTarget === true && Date.now() < this.powerTransitionUntil) ||
            this.deferredPowerOnPending;
        if (this.pendingPowerOnCommand &&
            this.pendingPowerOnRetries > 0 &&
            withinPowerOnGrace &&
            this.lastPowerOnWriteAt > 0 &&
            this.lastDataReceivedAt < this.lastPowerOnWriteAt) {
            this.pendingPowerOnRetries -= 1;
            if (!this.commandQueue.includes(this.pendingPowerOnCommand)) {
                this.commandQueue.unshift(this.pendingPowerOnCommand);
            }
            this.log.warn(`[${this.config.host}:${this.config.port}] Connection closed before projector acknowledged ${this.pendingPowerOnCommand} — will retry on reconnect (${this.pendingPowerOnRetries} attempt(s) left).`);
        }
        this.disconnect();
        this.recordHeartbeatFailure();
        if (prevPower && !withinPowerOnGrace) {
            this.state.power = false;
            this.state.powerStatus = 'OFF';
            this.emit('powerChange', false);
        }
        this.emit('disconnected');
        if (!this.isDestroyed && this.heartbeatActive) {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
            }
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                this.connect();
            }, this.config.reconnectInterval * 1000);
        }
    }
    startPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        this.pollTimer = setInterval(() => {
            if (this.isDestroyed || !this.heartbeatActive) {
                return;
            }
            if (!this.isConnected()) {
                this.recordHeartbeatFailure();
                if (!this.isConnecting && !this.socket) {
                    this.connect();
                }
                return;
            }
            if (this.lastProbeSentAt > this.lastDataReceivedAt &&
                Date.now() - this.lastProbeSentAt > this.config.pollInterval * 2000) {
                this.recordHeartbeatFailure();
                this.handleSocketClose();
                return;
            }
            this.lastProbeSentAt = Date.now();
            this.pollStatus();
        }, this.config.pollInterval * 1000);
    }
    /**
     * Polls the projector for current power, shutter, and input/channel states.
     */
    pollStatus() {
        this.sendRaw(this.config.stateCommand);
        if (this.state.power && this.powerTransitionTarget !== true && !this.deferredPowerOnPending) {
            this.queryShutter();
            this.queryInput();
            this.queryFreeze();
        }
    }
    // --- Protocol Parsing ---
    markUnitResponding() {
        this.lastDataReceivedAt = Date.now();
        if (this.pendingPowerOnCommand && this.lastPowerOnWriteAt > 0 && this.lastDataReceivedAt >= this.lastPowerOnWriteAt) {
            this.pendingPowerOnCommand = null;
            this.pendingPowerOnRetries = 0;
        }
        if (this.awaitingResponse) {
            this.awaitingResponse = false;
            this.emit('connected');
        }
    }
    /**
     * Extracts both parenthesized Christie frames `(CMD!...)` and newline-delimited messages.
     * Christie projectors often send `(PWR!001)` or `(PWR!10)` without a trailing newline,
     * or multiple parenthesized tokens back-to-back.
     */
    handleIncomingData(chunk) {
        this.buffer += chunk;
        // 1. Extract all complete parenthesized messages `(...)` immediately
        let match;
        const parenRegex = /\(([^()]+)\)/;
        while ((match = parenRegex.exec(this.buffer)) !== null) {
            const fullFrame = match[0];
            const innerContent = match[1].trim();
            const before = this.buffer.slice(0, match.index).trim();
            if (before) {
                this.processLine(before);
            }
            this.buffer = this.buffer.slice(match.index + fullFrame.length);
            this.processFrame(innerContent, fullFrame);
        }
        // 2. Also process any non-parenthesized newline-delimited lines
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line) {
                this.processLine(line);
            }
        }
    }
    processLine(line) {
        this.markUnitResponding();
        this.emit('lineReceived', line);
        const stripped = line.replace(/^\(/, '').replace(/\)$/, '').trim();
        if (stripped) {
            this.parseToken(stripped, line);
        }
    }
    processFrame(inner, fullFrame) {
        this.markUnitResponding();
        this.emit('lineReceived', fullFrame);
        this.parseToken(inner, fullFrame);
    }
    /**
     * Parses the inner content of a Christie response frame, e.g.:
     * - `PWR!001` or `PWR!001 "On"` or `PWR!10` or `PWR!000 "Standby"`
     * - `PWR+STAT!010` or `PWR+COOL!045` (CineLife / Solaria cooldown timer)
     * - `SHU!000` or `SHU!1`
     * - `SIN!001` or `SIN+MAIN!002`
     * - `CHA!101`
     * - `FRZ!001`
     * - `OSD!001`
     * - `ITP!000`
     * - `PIP!001`
     * - `LPW!085`
     * - `LPH!00420`
     * - `BRT!050`, `CON!050`, `CLR!050`, `SHP!050`, `GAM!002`
     * - `ZOM!100`, `FCS!100`, `LHO!050`, `LVO!050`
     * - `ILF!001`, `SZE!001`
     */
    parseToken(inner, rawFrame) {
        this.log.debug(`[Christie RX] ${rawFrame}`);
        // Match Christie reply pattern: CMD!VALUE or CMD+SUB!VALUE
        const replyMatch = inner.match(/^([A-Z]{3}(?:\+[A-Z0-9]+)?)!\s*(.*)$/i);
        if (!replyMatch) {
            return;
        }
        const commandCode = replyMatch[1].toUpperCase();
        const rawPayload = replyMatch[2].trim();
        // Extract leading token (often numeric code) and optional quoted description
        const quoteMatch = rawPayload.match(/^([^\s"]*)\s*(?:"([^"]*)")?/);
        const valueToken = quoteMatch ? quoteMatch[1].trim() : rawPayload;
        const description = quoteMatch && quoteMatch[2] ? quoteMatch[2].trim() : '';
        this.emit('commandReply', commandCode, valueToken, description, rawFrame);
        switch (commandCode) {
            case 'PWR':
            case 'PWR+STAT': {
                this.handlePowerReply(valueToken, description);
                break;
            }
            case 'PWR+COOL': {
                const remainingSec = parseInt(valueToken, 10);
                if (!isNaN(remainingSec) && remainingSec >= 0 && /^\d+$/.test(valueToken)) {
                    this.cooldownQuerySupported = true;
                    this.handleCooldownTimerReply(remainingSec);
                }
                else {
                    this.cooldownQuerySupported = false;
                    this.log.debug(`[${this.config.host}] Projector does not support (PWR+COOL?) (${rawFrame}) — using configured cooldownGraceSeconds (${this.config.cooldownGraceSeconds}s).`);
                }
                break;
            }
            case 'SHU': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    const closed = num === 1;
                    this.state.shutterClosed = closed;
                    this.emit('shutterChange', closed);
                }
                break;
            }
            case 'SIN':
            case 'SIN+MAIN': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.currentInput = num;
                    this.emit('inputChange', num);
                }
                break;
            }
            case 'CHA': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.currentChannel = num;
                    if (this.config.inputCommandType === 'CHA') {
                        this.state.currentInput = num;
                        this.emit('inputChange', num);
                    }
                    this.emit('channelChange', num);
                }
                break;
            }
            case 'FRZ': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    const frozen = num === 1;
                    this.state.freeze = frozen;
                    this.emit('freezeChange', frozen);
                }
                break;
            }
            case 'OSD': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    const visible = num === 1;
                    this.state.osd = visible;
                    this.emit('osdChange', visible);
                }
                break;
            }
            case 'PIP': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    const enabled = num === 1;
                    this.state.pip = enabled;
                    this.emit('pipChange', enabled);
                }
                break;
            }
            case 'ITP': {
                const num = parseInt(valueToken, 10);
                const val = !isNaN(num) ? num : (description || valueToken);
                this.state.currentTestPattern = val;
                this.emit('testPatternChange', val);
                break;
            }
            case 'ILF':
            case 'LML':
            case 'ILM': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.currentLensMemory = num;
                    this.emit('lensMemoryChange', num);
                }
                break;
            }
            case 'SZE': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.currentSizeMode = num;
                    this.emit('sizeModeChange', num);
                }
                break;
            }
            case 'LPW': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.lightPower = Math.min(100, Math.max(0, Math.round(num)));
                    this.emit('lightPowerChange', this.state.lightPower);
                }
                break;
            }
            case 'LPH': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.lampHours = num;
                    this.emit('lampHoursChange', num);
                }
                break;
            }
            case 'BRT': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.brightness = num;
                    this.emit('brightnessChange', num);
                }
                break;
            }
            case 'CON': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.contrast = num;
                    this.emit('contrastChange', num);
                }
                break;
            }
            case 'CLR': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.colorSaturation = num;
                    this.emit('colorChange', num);
                }
                break;
            }
            case 'SHP': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.sharpness = num;
                    this.emit('sharpnessChange', num);
                }
                break;
            }
            case 'GAM': {
                const num = parseFloat(valueToken);
                this.state.gamma = !isNaN(num) ? num : (description || valueToken);
                this.emit('gammaChange', this.state.gamma);
                break;
            }
            case 'ZOM': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.zoom = num;
                    this.emit('zoomChange', num);
                }
                break;
            }
            case 'FCS': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.focus = num;
                    this.emit('focusChange', num);
                }
                break;
            }
            case 'LHO': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.lensHorizontalShift = num;
                    this.emit('lensHorizontalShiftChange', num);
                }
                break;
            }
            case 'LVO': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.lensVerticalShift = num;
                    this.emit('lensVerticalShiftChange', num);
                }
                break;
            }
            case 'KST': {
                const num = parseFloat(valueToken);
                if (!isNaN(num)) {
                    this.state.keystone = num;
                    this.emit('keystoneChange', num);
                }
                break;
            }
            case 'WRP': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.warpMap = num;
                    this.emit('warpMapChange', num);
                }
                break;
            }
            case 'EDG': {
                const num = parseInt(valueToken, 10);
                if (!isNaN(num)) {
                    this.state.edgeBlend = num;
                    this.emit('edgeBlendChange', num);
                }
                break;
            }
            case 'UID':
            case 'PIF': {
                if (rawPayload) {
                    this.state.model = description || valueToken || rawPayload;
                    this.emit('projectorInfo', this.state.model);
                }
                break;
            }
            default:
                break;
        }
    }
    /**
     * Handles live remaining cooldown seconds reported by CineLife/Solaria `(PWR+COOL!<sec>)`.
     */
    handleCooldownTimerReply(remainingSec) {
        this.state.cooldownRemainingSeconds = remainingSec;
        this.emit('cooldownChange', remainingSec);
        if (remainingSec > 0) {
            const newCooldownUntil = Date.now() + remainingSec * 1000;
            this.cooldownUntil = newCooldownUntil;
            if (this.powerTransitionTarget === false) {
                this.powerTransitionUntil = Math.max(this.powerTransitionUntil, newCooldownUntil);
            }
            if (this.deferredPowerOnPending) {
                this.powerTransitionUntil = newCooldownUntil + this.config.cooldownGraceSeconds * 1000;
                this.log.info(`[${this.config.host}] Projector reports ${remainingSec}s remaining in cooldown (PWR+COOL!${remainingSec}) — adjusted deferred power ON wait.`);
                this.scheduleDeferredPowerOn(remainingSec * 1000);
            }
            else {
                this.log.info(`[${this.config.host}] Projector reports ${remainingSec}s remaining in cooldown (PWR+COOL!${remainingSec}).`);
            }
            return;
        }
        // remainingSec === 0: cooldown timer completed
        this.cooldownUntil = 0;
        this.cooldownQueryAttemptedForCycle = false;
        if (this.deferredPowerOnPending) {
            this.triggerDeferredPowerOn('Projector cooldown timer reached 0s (PWR+COOL!0)');
        }
    }
    /**
     * Interprets Christie `PWR!` status codes:
     * - `0` / `00` / `000` (and `3` on CineLife): Standby / Power Off
     * - `1` / `01` / `001`: Power On (Lamp/Laser On)
     * - `10` / `010`: Cooling Down (or Active/On outside cooldown when `treatCode10AsOn` is enabled)
     * - `11` / `011`: Warming Up
     * - `20`..`23` / `020`..`023`: AutoShutdown / Emergency Shutdown
     */
    handlePowerReply(code, description) {
        this.state.rawPowerCode = code;
        const numericCode = parseInt(code, 10);
        const descLower = description.toLowerCase();
        const now = Date.now();
        const prevPower = this.state.power;
        const prevStatus = this.state.powerStatus;
        let newStatus = this.state.powerStatus;
        let rawPower = this.state.power;
        if (numericCode === 0 || numericCode === 3) {
            newStatus = 'OFF';
            rawPower = false;
        }
        else if (numericCode === 1) {
            newStatus = 'ON';
            rawPower = true;
        }
        else if (numericCode === 11) {
            newStatus = 'WARMING';
            rawPower = true;
        }
        else if (numericCode === 10) {
            const inOffOrCooldownWindow = this.isCooldownActive() ||
                (this.powerTransitionTarget === false && now < this.powerTransitionUntil) ||
                this.deferredPowerOnPending;
            if (descLower.includes('cool') || inOffOrCooldownWindow) {
                newStatus = 'COOLING';
                rawPower = false;
            }
            else if (this.config.treatCode10AsOn) {
                newStatus = 'ON';
                rawPower = true;
            }
            else {
                newStatus = 'COOLING';
                rawPower = false;
            }
        }
        else if (numericCode >= 20 && numericCode <= 22) {
            newStatus = 'AUTO_SHUTDOWN';
            rawPower = false;
        }
        else if (numericCode === 23) {
            newStatus = 'EMERGENCY_SHUTDOWN';
            rawPower = false;
        }
        const isStandbyOff = newStatus === 'OFF' ||
            newStatus === 'AUTO_SHUTDOWN' ||
            newStatus === 'EMERGENCY_SHUTDOWN';
        // 1. Cooldown & transition lifecycle updates
        if (isStandbyOff) {
            const wasCooling = prevStatus === 'COOLING' || this.isCooldownActive();
            this.cooldownUntil = 0;
            this.state.cooldownRemainingSeconds = 0;
            this.cooldownQueryAttemptedForCycle = false;
            this.cooldownLoggedForCycle = false;
            if (this.deferredPowerOnPending) {
                this.state.powerStatus = newStatus;
                if (prevStatus !== newStatus) {
                    this.emit('powerStatusChange', newStatus, code);
                }
                this.triggerDeferredPowerOn(`Projector exited cooldown (PWR!${code})`);
                return;
            }
            if (this.powerTransitionTarget === false) {
                this.powerTransitionTarget = null;
                this.powerTransitionUntil = 0;
                this.clearTransitionTimer();
                if (wasCooling) {
                    this.log.info(`[${this.config.host}] Projector cooldown complete — unit is now in standby (PWR!${code}).`);
                }
                this.heartbeatLogState = 'logged-failure';
            }
        }
        else if (newStatus === 'COOLING') {
            // If projector entered COOLING externally (not via HomeKit powerOff), start tracking cooldown.
            if (!this.isCooldownActive() && prevStatus !== 'COOLING' && this.config.cooldownGraceSeconds > 0) {
                this.cooldownUntil = now + this.config.cooldownGraceSeconds * 1000;
                this.cooldownQueryAttemptedForCycle = false;
                this.cooldownLoggedForCycle = false;
            }
            const remainingSec = Math.ceil(this.getRemainingCooldownMs() / 1000);
            this.state.cooldownRemainingSeconds = remainingSec;
            // Never clear powerTransitionTarget or cooldownUntil while still COOLING!
            if (!this.cooldownLoggedForCycle && this.heartbeatActive && !this.deferredPowerOnPending) {
                this.cooldownLoggedForCycle = true;
                this.log.info(`[${this.config.host}] Projector is cooling down (PWR!${code}) — HomeKit is OFF; waiting for cooldown to finish${remainingSec > 0 ? ` (~${remainingSec}s remaining)` : ''}.`);
            }
            // Probe CineLife/Solaria live cooldown timer once per cycle if connected and supported
            if (this.cooldownQuerySupported !== false && !this.cooldownQueryAttemptedForCycle && this.isConnected()) {
                this.cooldownQueryAttemptedForCycle = true;
                this.queryCooldown();
            }
        }
        else if (newStatus === 'ON') {
            if (this.powerTransitionTarget === true) {
                this.powerTransitionTarget = null;
                this.powerTransitionUntil = 0;
                this.cooldownUntil = 0;
                this.state.cooldownRemainingSeconds = 0;
                this.clearTransitionTimer();
            }
        }
        // 2. Respect active power transition window & deferred power-on so HomeKit never snaps back
        let computedPower = rawPower;
        const inTransitionWindow = this.powerTransitionTarget !== null && now < this.powerTransitionUntil;
        if (this.deferredPowerOnPending) {
            computedPower = true;
        }
        else if (inTransitionWindow) {
            computedPower = this.powerTransitionTarget;
        }
        else if (this.powerTransitionTarget !== null && now >= this.powerTransitionUntil) {
            this.powerTransitionTarget = null;
            this.powerTransitionUntil = 0;
        }
        // 3. Heartbeat & state-change logging (never report errors or unexpected ON while cooling down)
        const inOffTransitionOrCooldown = (this.powerTransitionTarget === false && now < this.powerTransitionUntil) ||
            newStatus === 'COOLING';
        if (this.deferredPowerOnPending || inOffTransitionOrCooldown) {
            // Quietly track transition/cooldown without misleading heartbeat failure/unexpected-ON logs
        }
        else if (computedPower) {
            this.recordHeartbeatSuccess();
        }
        else if (isStandbyOff) {
            if (prevPower && this.expectedPowerState === 'on') {
                this.log.info(`[${this.config.host}] Projector powered off externally (PWR!${code}).`);
                this.expectedPowerState = 'off';
                this.heartbeatLogState = 'logged-failure';
            }
        }
        else {
            this.recordHeartbeatFailure();
        }
        this.state.power = computedPower;
        this.state.powerStatus = newStatus;
        if (prevStatus !== newStatus) {
            this.emit('powerStatusChange', newStatus, code);
        }
        if (prevPower !== computedPower) {
            this.log.debug(`[${this.config.host}] Christie Projector power state -> ${computedPower ? 'ON' : 'OFF'} (PWR!${code})`);
            this.emit('powerChange', computedPower);
        }
    }
    // --- Commands ---
    writeToSocket(formattedCommand) {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        const formattedOn = ChristieClient.formatCommand(this.config.onCommand);
        const formattedOff = ChristieClient.formatCommand(this.config.offCommand);
        const isPowerCmd = formattedCommand === formattedOn || formattedCommand === formattedOff;
        if (formattedCommand === this.pendingPowerOnCommand) {
            this.lastPowerOnWriteAt = Date.now();
        }
        this.log.debug(`[Christie TX] ${formattedCommand}`);
        this.socket.write(`${formattedCommand}\r\n`, (err) => {
            if (err) {
                this.log.warn(`[${this.config.host}:${this.config.port}] Failed to transmit ${formattedCommand}: ${err.message}`);
                if (isPowerCmd && !this.commandQueue.includes(formattedCommand)) {
                    this.commandQueue.unshift(formattedCommand);
                }
                this.handleSocketClose();
                return;
            }
            if (isPowerCmd) {
                this.log.info(`[${this.config.host}:${this.config.port}] Transmitted ${formattedCommand}`);
            }
        });
    }
    /**
     * Sends a Christie command (automatically wrapped in parentheses if not already).
     * If the TCP socket is disconnected, queues the command and initiates connection immediately.
     */
    sendRaw(rawCommand) {
        const formatted = ChristieClient.formatCommand(rawCommand);
        if (!formatted) {
            return;
        }
        if (this.isConnected()) {
            this.writeToSocket(formatted);
        }
        else {
            if (!this.commandQueue.includes(formatted)) {
                this.commandQueue.push(formatted);
            }
            if (this.heartbeatActive) {
                this.connect();
            }
        }
    }
    scheduleDeferredPowerOn(delayMs) {
        if (this.deferredPowerOnTimer) {
            clearTimeout(this.deferredPowerOnTimer);
            this.deferredPowerOnTimer = undefined;
        }
        const safeDelayMs = Math.max(0, delayMs);
        this.deferredPowerOnTimer = setTimeout(() => {
            this.deferredPowerOnTimer = undefined;
            if (this.isDestroyed || !this.deferredPowerOnPending) {
                return;
            }
            this.triggerDeferredPowerOn('Cooldown window elapsed');
        }, safeDelayMs);
    }
    triggerDeferredPowerOn(reason) {
        if (!this.deferredPowerOnPending) {
            return;
        }
        this.deferredPowerOnPending = false;
        if (this.deferredPowerOnTimer) {
            clearTimeout(this.deferredPowerOnTimer);
            this.deferredPowerOnTimer = undefined;
        }
        this.cooldownUntil = 0;
        this.state.cooldownRemainingSeconds = 0;
        this.log.info(`[${this.config.host}:${this.config.port}] ${reason} — executing deferred power ON now.`);
        void this.executePowerOn();
    }
    async executePowerOn() {
        if (this.isDestroyed) {
            return;
        }
        const formattedOn = ChristieClient.formatCommand(this.config.onCommand);
        const formattedOff = ChristieClient.formatCommand(this.config.offCommand);
        this.commandQueue = this.commandQueue.filter((cmd) => cmd !== formattedOff);
        this.log.info(`[${this.config.host}:${this.config.port}] Sending power ON command -> ${formattedOn}`);
        this.cooldownUntil = 0;
        this.state.cooldownRemainingSeconds = 0;
        this.cooldownQueryAttemptedForCycle = false;
        this.cooldownLoggedForCycle = false;
        this.powerTransitionTarget = true;
        this.powerTransitionUntil = Date.now() + this.config.cooldownGraceSeconds * 1000;
        this.pendingPowerOnCommand = formattedOn;
        this.pendingPowerOnRetries = 3;
        this.lastPowerOnWriteAt = 0;
        const prevPower = this.state.power;
        this.state.power = true;
        this.state.powerStatus = 'WARMING';
        if (!prevPower) {
            this.emit('powerChange', true);
        }
        if (this.config.mac) {
            try {
                await this.sendWakeOnLan(this.config.mac);
                this.log.info(`[${this.config.host}:${this.config.port}] Sent Wake-on-LAN packet to ${this.config.mac}`);
            }
            catch (err) {
                const error = err;
                this.log.warn(`[${this.config.host}:${this.config.port}] Wake-on-LAN error: ${error.message}`);
            }
        }
        // If an existing socket has not received data recently (possible half-open ghost socket
        // left over from standby), reset it so the ON command is sent over a fresh TCP connection.
        const socketAgeMs = this.lastDataReceivedAt > 0 ? Date.now() - this.lastDataReceivedAt : Infinity;
        if (this.socket && (this.isConnecting || socketAgeMs > this.config.pollInterval * 1000)) {
            this.disconnect();
        }
        // Queue ON command before opening/using the connection so it is always flushed first.
        if (!this.isConnected() && !this.commandQueue.includes(formattedOn)) {
            this.commandQueue.unshift(formattedOn);
        }
        this.beginHeartbeatProbing();
        if (this.isConnected()) {
            this.sendRaw(formattedOn);
        }
        this.scheduleTransitionCheck();
    }
    /**
     * Power On: Sends `(PWR 1)` (or configured `onCommand`), plus optional Wake-on-LAN if `mac` is set.
     * If the projector is still within its cooldown window (from a recent power OFF or active `COOLING` state),
     * defers sending `(PWR 1)` until the remaining cooldown elapses or standby `(PWR!000)` / `(PWR+COOL!0)` is confirmed.
     */
    async powerOn() {
        const formattedOn = ChristieClient.formatCommand(this.config.onCommand);
        const remainingCooldownMs = this.getRemainingCooldownMs();
        if (remainingCooldownMs > 0) {
            const remainingSeconds = Math.ceil(remainingCooldownMs / 1000);
            this.state.cooldownRemainingSeconds = remainingSeconds;
            this.powerTransitionTarget = true;
            this.powerTransitionUntil =
                this.cooldownUntil + this.config.cooldownGraceSeconds * 1000;
            const prevPower = this.state.power;
            this.state.power = true;
            if (!prevPower) {
                this.emit('powerChange', true);
            }
            if (this.deferredPowerOnPending) {
                this.log.info(`[${this.config.host}:${this.config.port}] Power ON already queued — waiting ~${remainingSeconds}s for projector cooldown to finish.`);
                return;
            }
            this.deferredPowerOnPending = true;
            const elapsedSinceOffSec = this.lastPowerOffAt > 0 ? Math.floor((Date.now() - this.lastPowerOffAt) / 1000) : null;
            const elapsedNote = elapsedSinceOffSec !== null ? ` (${elapsedSinceOffSec}s since power OFF)` : '';
            this.log.info(`[${this.config.host}:${this.config.port}] Projector is cooling down${elapsedNote} — waiting ${remainingSeconds}s before sending ${formattedOn} (or until standby (PWR!000) is confirmed).`);
            this.scheduleDeferredPowerOn(remainingCooldownMs);
            this.heartbeatActive = true;
            if (!this.pollTimer) {
                this.startPolling();
            }
            if (this.cooldownQuerySupported === true && this.isConnected()) {
                this.queryCooldown();
            }
            this.scheduleTransitionCheck();
            return;
        }
        await this.executePowerOn();
    }
    /**
     * Power Off: Immediately updates HomeKit state to OFF and sends `(PWR 0)` (or configured `offCommand`).
     * Tracks the cooldown window so cooling-down `(PWR!10)` replies never snap HomeKit back to ON,
     * and any subsequent `powerOn()` automatically waits for the remaining cooldown.
     */
    powerOff() {
        const formattedOff = ChristieClient.formatCommand(this.config.offCommand);
        const formattedOn = ChristieClient.formatCommand(this.config.onCommand);
        this.commandQueue = this.commandQueue.filter((cmd) => cmd !== formattedOn);
        const wasDeferredOn = this.deferredPowerOnPending;
        if (this.deferredPowerOnTimer) {
            clearTimeout(this.deferredPowerOnTimer);
            this.deferredPowerOnTimer = undefined;
        }
        this.deferredPowerOnPending = false;
        this.pendingPowerOnCommand = null;
        this.pendingPowerOnRetries = 0;
        this.lastPowerOnWriteAt = 0;
        this.heartbeatActive = true;
        this.expectedPowerState = 'off';
        this.heartbeatLogState = 'awaiting-expected-failure';
        if (!this.pollTimer) {
            this.startPolling();
        }
        const now = Date.now();
        // If canceling a deferred ON while still in the original cooldown, preserve the remaining cooldown
        if (!wasDeferredOn || this.cooldownUntil <= now) {
            this.lastPowerOffAt = now;
            this.cooldownUntil = now + this.config.cooldownGraceSeconds * 1000;
            this.cooldownQueryAttemptedForCycle = false;
            this.cooldownLoggedForCycle = false;
        }
        this.powerTransitionTarget = false;
        this.powerTransitionUntil = this.cooldownUntil;
        this.state.cooldownRemainingSeconds = Math.ceil(this.getRemainingCooldownMs() / 1000);
        const prevPower = this.state.power;
        this.state.power = false;
        this.state.powerStatus = this.config.cooldownGraceSeconds > 0 ? 'COOLING' : 'OFF';
        if (prevPower) {
            this.emit('powerChange', false);
        }
        if (wasDeferredOn) {
            this.log.info(`[${this.config.host}:${this.config.port}] Canceled deferred power ON — projector remains in cooldown (~${this.state.cooldownRemainingSeconds}s remaining).`);
            this.scheduleTransitionCheck();
            return;
        }
        this.log.info(`[${this.config.host}:${this.config.port}] Sending power OFF command -> ${formattedOff} (cooldown window: ${this.config.cooldownGraceSeconds}s)`);
        this.sendRaw(formattedOff);
        this.scheduleTransitionCheck();
    }
    scheduleTransitionCheck() {
        this.clearTransitionTimer();
        let checks = 0;
        const maxChecks = Math.max(10, Math.ceil(this.config.cooldownGraceSeconds / 3) + 2);
        this.transitionTimer = setInterval(() => {
            checks++;
            if (this.isDestroyed ||
                checks > maxChecks ||
                (this.powerTransitionTarget === null && !this.deferredPowerOnPending)) {
                this.clearTransitionTimer();
                return;
            }
            if (this.isConnected()) {
                this.queryPower();
            }
        }, 3000);
    }
    /**
     * Query Power State `(PWR?)`
     */
    queryPower() {
        this.sendRaw(this.config.stateCommand);
    }
    /**
     * Query Remaining Cooldown Timer `(PWR+COOL?)` (supported on CineLife / Solaria models)
     */
    queryCooldown() {
        this.sendRaw('(PWR+COOL?)');
    }
    /**
     * Set Standby Mode:
     * - `1` = Communication Mode (keeps Ethernet / RS-232 port 3002 active during standby)
     * - `0` = Low Power Eco Mode (0.5W)
     */
    setStandbyMode(communicationMode) {
        this.log.info(`[${this.config.host}] Setting Standby Mode -> ${communicationMode ? 'Communication (1)' : 'Eco (0)'}`);
        this.sendRaw(`(PWR+STBM ${communicationMode ? 1 : 0})`);
    }
    /**
     * Keep video electronics active in standby `(PWR+ELEC 1/0)`
     */
    setStandbyElectronics(enabled) {
        this.sendRaw(`(PWR+ELEC ${enabled ? 1 : 0})`);
    }
    // --- Shutter / Picture Mute (SHU) ---
    /**
     * Open `(SHU 0)` or Close `(SHU 1)` the shutter (Picture Mute / Blackout).
     */
    setShutter(closed) {
        this.log.info(`[${this.config.host}] Setting Shutter -> ${closed ? 'CLOSED / Blackout (SHU 1)' : 'OPEN (SHU 0)'}`);
        this.state.shutterClosed = closed;
        this.sendRaw(`(SHU ${closed ? 1 : 0})`);
        this.emit('shutterChange', closed);
    }
    openShutter() {
        this.setShutter(false);
    }
    closeShutter() {
        this.setShutter(true);
    }
    queryShutter() {
        this.sendRaw('(SHU?)');
    }
    // --- Input Selection (SIN) & Channels (CHA) ---
    /**
     * Select Active Input Source via `(SIN <id>)`, `(SIN+MAIN <id>)`, `(SIN+PIP <id>)`, or `(CHA <id>)`.
     */
    setInput(inputId, subcode) {
        const numId = typeof inputId === 'number' ? inputId : parseInt(String(inputId), 10);
        if (!isNaN(numId)) {
            this.state.currentInput = numId;
        }
        if (subcode === 'CHA' || (!subcode && this.config.inputCommandType === 'CHA')) {
            this.log.info(`[${this.config.host}] Selecting Channel -> (CHA ${inputId})`);
            this.sendRaw(`(CHA ${inputId})`);
            return;
        }
        if (subcode === 'PIP') {
            this.log.info(`[${this.config.host}] Selecting PIP Input -> (SIN+PIP ${inputId})`);
            this.sendRaw(`(SIN+PIP ${inputId})`);
            return;
        }
        if (subcode === 'MAIN' || this.config.inputCommandType === 'SIN+MAIN') {
            this.log.info(`[${this.config.host}] Selecting Main Input -> (SIN+MAIN ${inputId})`);
            this.sendRaw(`(SIN+MAIN ${inputId})`);
            return;
        }
        this.log.info(`[${this.config.host}] Selecting Input -> (SIN ${inputId})`);
        this.sendRaw(`(SIN ${inputId})`);
    }
    queryInput() {
        if (this.config.inputCommandType === 'CHA') {
            this.sendRaw('(CHA?)');
        }
        else if (this.config.inputCommandType === 'SIN+MAIN') {
            this.sendRaw('(SIN+MAIN?)');
        }
        else {
            this.sendRaw('(SIN?)');
        }
    }
    /**
     * Select Channel / Preset Source Configuration `(CHA <channelId>)`
     */
    setChannel(channelId) {
        const numId = typeof channelId === 'number' ? channelId : parseInt(String(channelId), 10);
        if (!isNaN(numId)) {
            this.state.currentChannel = numId;
        }
        this.log.info(`[${this.config.host}] Selecting Channel -> (CHA ${channelId})`);
        this.sendRaw(`(CHA ${channelId})`);
    }
    queryChannel() {
        this.sendRaw('(CHA?)');
    }
    // --- Image Freeze (FRZ) ---
    setFreeze(frozen) {
        this.log.info(`[${this.config.host}] Setting Image Freeze -> (FRZ ${frozen ? 1 : 0})`);
        this.state.freeze = frozen;
        this.sendRaw(`(FRZ ${frozen ? 1 : 0})`);
        this.emit('freezeChange', frozen);
    }
    queryFreeze() {
        this.sendRaw('(FRZ?)');
    }
    // --- On-Screen Display (OSD) ---
    setOsd(visible) {
        this.log.info(`[${this.config.host}] Setting On-Screen Display -> (OSD ${visible ? 1 : 0})`);
        this.state.osd = visible;
        this.sendRaw(`(OSD ${visible ? 1 : 0})`);
        this.emit('osdChange', visible);
    }
    queryOsd() {
        this.sendRaw('(OSD?)');
    }
    // --- Picture-in-Picture (PIP / PPS) ---
    setPip(enabled) {
        this.log.info(`[${this.config.host}] Setting Picture-in-Picture -> (PIP ${enabled ? 1 : 0})`);
        this.state.pip = enabled;
        this.sendRaw(`(PIP ${enabled ? 1 : 0})`);
        this.emit('pipChange', enabled);
    }
    swapPip() {
        this.log.info(`[${this.config.host}] Swapping Main & PIP windows -> (PPS 1)`);
        this.sendRaw('(PPS 1)');
    }
    queryPip() {
        this.sendRaw('(PIP?)');
    }
    // --- Internal Test Patterns (ITP) ---
    /**
     * Display an internal test pattern `(ITP <pattern>)` or turn off test pattern `(ITP 0)`.
     */
    setTestPattern(pattern) {
        this.log.info(`[${this.config.host}] Setting Internal Test Pattern -> (ITP ${pattern})`);
        this.state.currentTestPattern = pattern;
        if (typeof pattern === 'number' || /^\d+$/.test(String(pattern))) {
            this.sendRaw(`(ITP ${pattern})`);
        }
        else {
            const clean = String(pattern).replace(/^"|"$/g, '');
            this.sendRaw(`(ITP "${clean}")`);
        }
        this.emit('testPatternChange', pattern);
    }
    queryTestPattern() {
        this.sendRaw('(ITP?)');
    }
    // --- Lens Control & Intelligent Lens Memory (ILM / ILF / LMS / LCB / ZOM / FCS / LHO / LVO) ---
    setIntelligentLensMemory(enabled) {
        this.log.info(`[${this.config.host}] Setting Intelligent Lens Memory -> (ILM ${enabled ? 1 : 0})`);
        this.sendRaw(`(ILM ${enabled ? 1 : 0})`);
    }
    /**
     * Recalls a saved Lens Memory / ILS file `(ILF <slot>)`.
     */
    recallLensMemory(slot, commandCode = 'ILF') {
        const numSlot = typeof slot === 'number' ? slot : parseInt(String(slot), 10);
        if (!isNaN(numSlot)) {
            this.state.currentLensMemory = numSlot;
        }
        this.log.info(`[${this.config.host}] Recalling Lens Memory -> (${commandCode} ${slot})`);
        this.sendRaw(`(${commandCode} ${slot})`);
        if (!isNaN(numSlot)) {
            this.emit('lensMemoryChange', numSlot);
        }
    }
    saveLensMemory(slot) {
        this.log.info(`[${this.config.host}] Saving Lens Memory -> (LMS ${slot})`);
        this.sendRaw(`(LMS ${slot})`);
    }
    /**
     * Calibrate motorized lens to home reference `(LCB 1)`.
     */
    calibrateLens() {
        this.log.info(`[${this.config.host}] Calibrating Lens to Home -> (LCB 1)`);
        this.sendRaw('(LCB 1)');
    }
    setZoom(value) {
        this.log.info(`[${this.config.host}] Setting Lens Zoom -> (ZOM ${value})`);
        this.state.zoom = value;
        this.sendRaw(`(ZOM ${value})`);
    }
    queryZoom() {
        this.sendRaw('(ZOM?)');
    }
    setFocus(value) {
        this.log.info(`[${this.config.host}] Setting Lens Focus -> (FCS ${value})`);
        this.state.focus = value;
        this.sendRaw(`(FCS ${value})`);
    }
    queryFocus() {
        this.sendRaw('(FCS?)');
    }
    setLensHorizontalShift(value) {
        this.log.info(`[${this.config.host}] Setting Lens Horizontal Shift -> (LHO ${value})`);
        this.state.lensHorizontalShift = value;
        this.sendRaw(`(LHO ${value})`);
    }
    queryLensHorizontalShift() {
        this.sendRaw('(LHO?)');
    }
    setLensVerticalShift(value) {
        this.log.info(`[${this.config.host}] Setting Lens Vertical Shift -> (LVO ${value})`);
        this.state.lensVerticalShift = value;
        this.sendRaw(`(LVO ${value})`);
    }
    queryLensVerticalShift() {
        this.sendRaw('(LVO?)');
    }
    // --- Image, Aspect Ratio, Geometry & Color Adjustments (BRT / CON / GAM / CLR / SHP / SZE / ASU / KST / WRP / EDG) ---
    setBrightness(value) {
        this.log.info(`[${this.config.host}] Setting Brightness -> (BRT ${value})`);
        this.state.brightness = value;
        this.sendRaw(`(BRT ${value})`);
    }
    queryBrightness() {
        this.sendRaw('(BRT?)');
    }
    setContrast(value) {
        this.log.info(`[${this.config.host}] Setting Contrast -> (CON ${value})`);
        this.state.contrast = value;
        this.sendRaw(`(CON ${value})`);
    }
    queryContrast() {
        this.sendRaw('(CON?)');
    }
    setColorSaturation(value) {
        this.log.info(`[${this.config.host}] Setting Color Saturation -> (CLR ${value})`);
        this.state.colorSaturation = value;
        this.sendRaw(`(CLR ${value})`);
    }
    queryColorSaturation() {
        this.sendRaw('(CLR?)');
    }
    setSharpness(value) {
        this.log.info(`[${this.config.host}] Setting Sharpness -> (SHP ${value})`);
        this.state.sharpness = value;
        this.sendRaw(`(SHP ${value})`);
    }
    querySharpness() {
        this.sendRaw('(SHP?)');
    }
    setGamma(value) {
        this.log.info(`[${this.config.host}] Setting Gamma -> (GAM ${value})`);
        this.state.gamma = value;
        this.sendRaw(`(GAM ${value})`);
    }
    queryGamma() {
        this.sendRaw('(GAM?)');
    }
    setSizeMode(mode) {
        const numMode = typeof mode === 'number' ? mode : parseInt(String(mode), 10);
        if (!isNaN(numMode)) {
            this.state.currentSizeMode = numMode;
        }
        this.log.info(`[${this.config.host}] Setting Aspect / Size Mode -> (SZE ${mode})`);
        this.sendRaw(`(SZE ${mode})`);
    }
    querySizeMode() {
        this.sendRaw('(SZE?)');
    }
    /**
     * Execute Auto Image Setup `(ASU 1)`
     */
    triggerAutoSetup() {
        this.log.info(`[${this.config.host}] Executing Auto Setup -> (ASU 1)`);
        this.sendRaw('(ASU 1)');
    }
    setKeystone(value) {
        this.log.info(`[${this.config.host}] Setting Keystone -> (KST ${value})`);
        this.state.keystone = value;
        this.sendRaw(`(KST ${value})`);
    }
    queryKeystone() {
        this.sendRaw('(KST?)');
    }
    setWarpMap(slot) {
        this.log.info(`[${this.config.host}] Selecting Warp Map -> (WRP ${slot})`);
        this.state.warpMap = slot;
        this.sendRaw(`(WRP ${slot})`);
    }
    queryWarpMap() {
        this.sendRaw('(WRP?)');
    }
    setEdgeBlend(slot) {
        this.log.info(`[${this.config.host}] Selecting Edge Blend -> (EDG ${slot})`);
        this.state.edgeBlend = slot;
        this.sendRaw(`(EDG ${slot})`);
    }
    queryEdgeBlend() {
        this.sendRaw('(EDG?)');
    }
    // --- Laser / Lamp Power & Hours (LPW / LPM / LPH) ---
    setLightPower(percentage) {
        const clamped = Math.min(100, Math.max(0, Math.round(percentage)));
        this.log.info(`[${this.config.host}] Setting Laser/Lamp Power -> (LPW ${clamped})`);
        this.state.lightPower = clamped;
        this.sendRaw(`(LPW ${clamped})`);
        this.emit('lightPowerChange', clamped);
    }
    queryLightPower() {
        this.sendRaw('(LPW?)');
    }
    setLightMode(mode) {
        this.log.info(`[${this.config.host}] Setting Light Source Mode -> (LPM ${mode})`);
        this.sendRaw(`(LPM ${mode})`);
    }
    queryLampHours() {
        this.sendRaw('(LPH?)');
    }
    // --- IR / Keypad Emulation (KEY) ---
    sendKey(keyCode) {
        this.log.debug(`[${this.config.host}] Sending Keypad Code -> (KEY ${keyCode})`);
        this.sendRaw(`(KEY ${keyCode})`);
    }
    // --- System Status & Diagnostics (SST / PIF / UID / ERR) ---
    querySystemStatus() {
        this.sendRaw('(SST?)');
    }
    queryProjectorInfo() {
        this.sendRaw('(PIF?)');
        this.sendRaw('(UID?)');
    }
    queryErrors() {
        this.sendRaw('(ERR?)');
    }
    // --- Wake On Lan Implementation ---
    sendWakeOnLan(macAddress) {
        return new Promise((resolve, reject) => {
            const cleanMac = macAddress.replace(/[^0-9a-fA-F]/g, '');
            if (cleanMac.length !== 12) {
                return reject(new Error(`Invalid MAC address: "${macAddress}"`));
            }
            const macBuffer = Buffer.from(cleanMac, 'hex');
            const magicPacket = Buffer.alloc(6 + 16 * 6);
            magicPacket.fill(0xff, 0, 6);
            for (let i = 0; i < 16; i++) {
                macBuffer.copy(magicPacket, 6 + i * 6);
            }
            const socket = dgram.createSocket('udp4');
            socket.once('error', (err) => {
                try {
                    socket.close();
                }
                catch {
                    // ignore
                }
                reject(err);
            });
            socket.bind(() => {
                try {
                    socket.setBroadcast(true);
                }
                catch {
                    // ignore
                }
                socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
                    try {
                        socket.close();
                    }
                    catch {
                        // ignore
                    }
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
        });
    }
}
exports.ChristieClient = ChristieClient;
//# sourceMappingURL=christieClient.js.map