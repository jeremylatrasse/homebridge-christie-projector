import { EventEmitter } from 'events';
import * as net from 'net';
import * as dgram from 'dgram';

export type ChristiePowerStatus =
  | 'OFF'
  | 'ON'
  | 'COOLING'
  | 'WARMING'
  | 'AUTO_SHUTDOWN'
  | 'EMERGENCY_SHUTDOWN';

export interface ChristieClientConfig {
  host: string;
  port?: number; // Default: 3002
  mac?: string;
  pollInterval?: number; // seconds, default: 10
  reconnectInterval?: number; // seconds, default: 5
  socketTimeoutMs?: number; // ms, default: 3000
  cooldownGraceSeconds?: number; // seconds, default: 60
  treatCode10AsOn?: boolean; // Whether (PWR!10) outside cooldown should be treated as ON (default: true)
  inputCommandType?: 'SIN' | 'SIN+MAIN' | 'CHA'; // Default: 'SIN'
  onCommand?: string; // Optional custom override, default: '(PWR 1)'
  offCommand?: string; // Optional custom override, default: '(PWR 0)'
  stateCommand?: string; // Optional custom override, default: '(PWR?)'
}

export interface ChristieState {
  power: boolean;
  powerStatus: ChristiePowerStatus;
  rawPowerCode: string | null;
  shutterClosed: boolean;
  freeze: boolean;
  osd: boolean;
  pip: boolean;
  currentInput: number;
  currentChannel: number;
  currentTestPattern: number | string;
  currentLensMemory: number;
  currentSizeMode: number;
  lightPower: number; // 0 - 100%
  brightness: number; // 0 - 100%
  contrast: number; // 0 - 100%
  sharpness: number;
  colorSaturation: number;
  gamma: number | string;
  zoom: number;
  focus: number;
  lensHorizontalShift: number;
  lensVerticalShift: number;
  keystone: number;
  warpMap: number;
  edgeBlend: number;
  lampHours: number | null;
  model: string | null;
  serialNumber: string | null;
  firmware: string | null;
  customStates: Map<string, boolean>;
}

export interface LoggerLike {
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
  debug(message: string, ...parameters: unknown[]): void;
}

/**
 * Christie Digital Serial / TCP Protocol Client (Default Port 3002).
 *
 * Implements the full Christie ASCII parenthesized command protocol:
 * - Commands: `(CMD <value>)\r\n` or `(CMD+SUB <value>)\r\n`
 * - Queries:  `(CMD?)\r\n` or `(CMD+SUB?)\r\n`
 * - Replies:  `(CMD!<value>)` or `(CMD!<value> "<description>")`
 */
export class ChristieClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private isConnecting = false;
  private isDestroyed = false;
  private buffer = '';
  private commandQueue: string[] = [];
  private reconnectTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private transitionTimer?: NodeJS.Timeout;
  private connectTimeoutTimer?: NodeJS.Timeout;
  private powerTransitionTarget: boolean | null = null;
  private powerTransitionUntil = 0;
  private awaitingResponse = false;
  private lastDataReceivedAt = 0;
  private lastProbeSentAt = 0;
  private heartbeatActive = false;
  private expectedPowerState: 'on' | 'off' = 'off';
  private heartbeatLogState: 'awaiting-success' | 'logged-success' | 'awaiting-expected-failure' | 'logged-failure' = 'logged-failure';
  private onCommandSentAt = 0;

  public readonly config: Required<ChristieClientConfig>;
  public state: ChristieState = {
    power: false,
    powerStatus: 'OFF',
    rawPowerCode: null,
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

  constructor(
    config: ChristieClientConfig,
    private readonly log: LoggerLike,
  ) {
    super();
    this.config = {
      host: config.host,
      port: config.port || 3002,
      mac: config.mac || '',
      pollInterval: config.pollInterval || 10,
      reconnectInterval: config.reconnectInterval || 5,
      socketTimeoutMs: config.socketTimeoutMs || 3000,
      cooldownGraceSeconds: config.cooldownGraceSeconds !== undefined ? config.cooldownGraceSeconds : 60,
      treatCode10AsOn: config.treatCode10AsOn !== undefined ? config.treatCode10AsOn : true,
      inputCommandType: config.inputCommandType || 'SIN',
      onCommand: config.onCommand || '(PWR 1)',
      offCommand: config.offCommand || '(PWR 0)',
      stateCommand: config.stateCommand || '(PWR?)',
    };
  }

  public start(): void {
    this.isDestroyed = false;
    // Heartbeat probing only begins once an ON command is sent
  }

  public stop(): void {
    this.isDestroyed = true;
    this.heartbeatActive = false;
    this.clearTimers();
    this.disconnect();
  }

  public restart(): void {
    this.log.info(`[${this.config.host}] Restarting Christie projector client connection...`);
    this.stop();
    this.isDestroyed = false;
    this.beginHeartbeatProbing();
  }

  private clearTimers(): void {
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
  }

  private beginHeartbeatProbing(): void {
    this.heartbeatActive = true;
    this.expectedPowerState = 'on';
    this.heartbeatLogState = 'awaiting-success';
    this.onCommandSentAt = Date.now();
    this.startPolling();
    this.connect();
  }

  private recordHeartbeatSuccess(): void {
    if (!this.heartbeatActive) {
      return;
    }
    if (this.heartbeatLogState !== 'logged-success') {
      if (this.expectedPowerState === 'off') {
        this.log.info(
          `[${this.config.host}] Heartbeat succeeded (unexpected state change while in OFF state) — unit is online.`,
        );
        this.expectedPowerState = 'on';
      } else {
        this.log.info(`[${this.config.host}] Heartbeat succeeded — unit is online and responding.`);
      }
      this.heartbeatLogState = 'logged-success';
    }
  }

  private recordHeartbeatFailure(): void {
    if (!this.heartbeatActive) {
      return;
    }
    if (this.expectedPowerState === 'off') {
      if (this.heartbeatLogState !== 'logged-failure') {
        this.log.info(
          `[${this.config.host}] Heartbeat failed as expected in OFF state — quietly probing until next ON command or state change.`,
        );
        this.heartbeatLogState = 'logged-failure';
      }
    } else {
      const bootGraceExpired =
        this.heartbeatLogState === 'awaiting-success' &&
        this.onCommandSentAt > 0 &&
        Date.now() - this.onCommandSentAt > this.config.cooldownGraceSeconds * 1000;
      if (this.heartbeatLogState === 'logged-success' || bootGraceExpired) {
        this.log.warn(
          `[${this.config.host}] Heartbeat failed in ON state — quietly probing until next ON command or state change.`,
        );
        this.heartbeatLogState = 'logged-failure';
      }
    }
  }

  public isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && !this.isConnecting;
  }

  /**
   * Formats a Christie ASCII command ensuring enclosing parentheses `(...)`.
   */
  public static formatCommand(rawCommand: string): string {
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
  public sendOneShot(rawCommand: string, timeoutMs = this.config.socketTimeoutMs): Promise<string> {
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
        } catch {
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

      client.on('data', (chunk: Buffer) => {
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
  public async checkIfResponding(timeoutMs = this.config.socketTimeoutMs): Promise<boolean> {
    const response = await this.sendOneShot(this.config.stateCommand, timeoutMs);
    return response.length > 0;
  }

  // --- Connection Management ---

  private connect(): void {
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

    socket.setKeepAlive(true, 10000);
    socket.setTimeout(Math.max(15000, this.config.pollInterval * 2000));

    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
    }
    this.connectTimeoutTimer = setTimeout(() => {
      this.connectTimeoutTimer = undefined;
      if (this.isConnecting) {
        this.log.debug(`[${this.config.host}] Connect attempt timed out`);
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

      // Flush any commands queued while connecting
      while (this.commandQueue.length > 0) {
        const nextCmd = this.commandQueue.shift()!;
        this.writeToSocket(nextCmd);
      }

      // Query initial projector state
      this.pollStatus();
    });

    socket.on('data', (data: Buffer) => {
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

    socket.on('error', (err: Error) => {
      this.log.debug(`[${this.config.host}] Socket error: ${err.message}`);
    });

    socket.on('close', (hadError: boolean) => {
      this.log.debug(`[${this.config.host}] Socket closed (hadError: ${hadError})`);
      this.handleSocketClose();
    });

    socket.connect(this.config.port, this.config.host);
  }

  private disconnect(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = undefined;
    }
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.end();
        this.socket.destroy();
      } catch {
        // ignore errors on tear-down
      }
      this.socket = null;
    }
    this.isConnecting = false;
    this.awaitingResponse = false;
    this.lastProbeSentAt = 0;
  }

  private handleSocketClose(): void {
    const prevPower = this.state.power;
    this.disconnect();
    this.recordHeartbeatFailure();
    if (prevPower) {
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

  private startPolling(): void {
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
      if (
        this.lastProbeSentAt > this.lastDataReceivedAt &&
        Date.now() - this.lastProbeSentAt > this.config.pollInterval * 2000
      ) {
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
  public pollStatus(): void {
    this.sendRaw(this.config.stateCommand);
    if (this.state.power) {
      this.queryShutter();
      this.queryInput();
      this.queryFreeze();
    }
  }

  // --- Protocol Parsing ---

  private markUnitResponding(): void {
    this.lastDataReceivedAt = Date.now();
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
  public handleIncomingData(chunk: string): void {
    this.buffer += chunk;

    // 1. Extract all complete parenthesized messages `(...)` immediately
    let match: RegExpExecArray | null;
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

  private processLine(line: string): void {
    this.markUnitResponding();
    this.emit('lineReceived', line);
    const stripped = line.replace(/^\(/, '').replace(/\)$/, '').trim();
    if (stripped) {
      this.parseToken(stripped, line);
    }
  }

  private processFrame(inner: string, fullFrame: string): void {
    this.markUnitResponding();
    this.emit('lineReceived', fullFrame);
    this.parseToken(inner, fullFrame);
  }

  /**
   * Parses the inner content of a Christie response frame, e.g.:
   * - `PWR!001` or `PWR!001 "On"` or `PWR!10` or `PWR!000 "Standby"`
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
  private parseToken(inner: string, rawFrame: string): void {
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
      case 'PWR': {
        this.handlePowerReply(valueToken, description);
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
   * Interprets Christie `PWR!` status codes:
   * - `0` / `00` / `000`: Standby / Power Off
   * - `1` / `01` / `001`: Power On (Lamp/Laser On)
   * - `10` / `010`: Cooling Down (or Active/On in setups matching `PWR!10` when not cooling down from powerOff)
   * - `11` / `011`: Warming Up
   * - `20`..`23` / `020`..`023`: AutoShutdown / Emergency Shutdown
   */
  private handlePowerReply(code: string, description: string): void {
    this.state.rawPowerCode = code;
    const numericCode = parseInt(code, 10);
    const descLower = description.toLowerCase();

    let newStatus: ChristiePowerStatus = this.state.powerStatus;
    let computedPower = this.state.power;

    if (numericCode === 0) {
      newStatus = 'OFF';
      computedPower = false;
    } else if (numericCode === 1) {
      newStatus = 'ON';
      computedPower = true;
    } else if (numericCode === 11) {
      newStatus = 'WARMING';
      computedPower = true;
    } else if (numericCode === 10) {
      if (descLower.includes('cool')) {
        newStatus = 'COOLING';
        computedPower = false;
      } else if (
        this.powerTransitionTarget === false &&
        Date.now() < this.powerTransitionUntil
      ) {
        newStatus = 'COOLING';
        computedPower = false;
      } else if (this.config.treatCode10AsOn) {
        newStatus = 'ON';
        computedPower = true;
      } else {
        newStatus = 'COOLING';
        computedPower = false;
      }
    } else if (numericCode >= 20 && numericCode <= 22) {
      newStatus = 'AUTO_SHUTDOWN';
      computedPower = false;
    } else if (numericCode === 23) {
      newStatus = 'EMERGENCY_SHUTDOWN';
      computedPower = false;
    }

    // Respect active power transition window so HomeKit UI doesn't snap back mid-transition
    if (this.powerTransitionTarget !== null && Date.now() < this.powerTransitionUntil) {
      if (computedPower === this.powerTransitionTarget) {
        // Target state reached, clear transition lock
        this.powerTransitionTarget = null;
        this.powerTransitionUntil = 0;
      } else {
        computedPower = this.powerTransitionTarget;
      }
    }

    if (computedPower) {
      this.recordHeartbeatSuccess();
    } else {
      this.recordHeartbeatFailure();
    }

    const prevPower = this.state.power;
    const prevStatus = this.state.powerStatus;
    this.state.power = computedPower;
    this.state.powerStatus = newStatus;

    if (prevStatus !== newStatus) {
      this.emit('powerStatusChange', newStatus, code);
    }
    if (prevPower !== computedPower) {
      this.log.debug(
        `[${this.config.host}] Christie Projector power state -> ${computedPower ? 'ON' : 'OFF'} (PWR!${code})`,
      );
      this.emit('powerChange', computedPower);
    }
  }

  // --- Commands ---

  private writeToSocket(formattedCommand: string): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    this.log.debug(`[Christie TX] ${formattedCommand}`);
    this.socket.write(`${formattedCommand}\r\n`);
  }

  /**
   * Sends a Christie command (automatically wrapped in parentheses if not already).
   * If the TCP socket is disconnected, queues the command and initiates connection immediately.
   */
  public sendRaw(rawCommand: string): void {
    const formatted = ChristieClient.formatCommand(rawCommand);
    if (!formatted) {
      return;
    }

    if (this.isConnected()) {
      this.writeToSocket(formatted);
    } else {
      if (!this.commandQueue.includes(formatted)) {
        this.commandQueue.push(formatted);
      }
      if (this.heartbeatActive) {
        this.connect();
      }
    }
  }

  /**
   * Power On: Sends `(PWR 1)` (or configured `onCommand`), plus optional Wake-on-LAN if `mac` is set.
   */
  public async powerOn(): Promise<void> {
    this.log.debug(`[${this.config.host}] Powering ON Christie Projector -> ${this.config.onCommand}`);
    this.powerTransitionTarget = true;
    this.powerTransitionUntil = Date.now() + this.config.cooldownGraceSeconds * 1000;

    const prevPower = this.state.power;
    this.state.power = true;
    this.state.powerStatus = 'WARMING';
    if (!prevPower) {
      this.emit('powerChange', true);
    }

    if (this.config.mac) {
      try {
        await this.sendWakeOnLan(this.config.mac);
        this.log.debug(`[${this.config.host}] Sent Wake-on-LAN packet to ${this.config.mac}`);
      } catch (err: unknown) {
        const error = err as Error;
        this.log.warn(`[${this.config.host}] Wake-on-LAN error: ${error.message}`);
      }
    }

    this.beginHeartbeatProbing();
    this.sendRaw(this.config.onCommand);
    this.scheduleTransitionCheck();
  }

  /**
   * Power Off: Sends `(PWR 0)` (or configured `offCommand`).
   */
  public powerOff(): void {
    this.log.debug(`[${this.config.host}] Powering OFF Christie Projector -> ${this.config.offCommand}`);
    this.heartbeatActive = true;
    this.expectedPowerState = 'off';
    this.heartbeatLogState = 'awaiting-expected-failure';
    if (!this.pollTimer) {
      this.startPolling();
    }

    this.powerTransitionTarget = false;
    this.powerTransitionUntil = Date.now() + this.config.cooldownGraceSeconds * 1000;

    const prevPower = this.state.power;
    this.state.power = false;
    this.state.powerStatus = 'COOLING';
    if (prevPower) {
      this.emit('powerChange', false);
    }

    this.sendRaw(this.config.offCommand);
    this.scheduleTransitionCheck();
  }

  private scheduleTransitionCheck(): void {
    if (this.transitionTimer) {
      clearInterval(this.transitionTimer);
    }
    let checks = 0;
    this.transitionTimer = setInterval(() => {
      checks++;
      if (this.isDestroyed || checks > 10) {
        if (this.transitionTimer) {
          clearInterval(this.transitionTimer);
          this.transitionTimer = undefined;
        }
        return;
      }
      this.queryPower();
    }, 3000);
  }

  /**
   * Query Power State `(PWR?)`
   */
  public queryPower(): void {
    this.sendRaw(this.config.stateCommand);
  }

  /**
   * Set Standby Mode:
   * - `1` = Communication Mode (keeps Ethernet / RS-232 port 3002 active during standby)
   * - `0` = Low Power Eco Mode (0.5W)
   */
  public setStandbyMode(communicationMode: boolean): void {
    this.log.info(`[${this.config.host}] Setting Standby Mode -> ${communicationMode ? 'Communication (1)' : 'Eco (0)'}`);
    this.sendRaw(`(PWR+STBM ${communicationMode ? 1 : 0})`);
  }

  /**
   * Keep video electronics active in standby `(PWR+ELEC 1/0)`
   */
  public setStandbyElectronics(enabled: boolean): void {
    this.sendRaw(`(PWR+ELEC ${enabled ? 1 : 0})`);
  }

  // --- Shutter / Picture Mute (SHU) ---

  /**
   * Open `(SHU 0)` or Close `(SHU 1)` the shutter (Picture Mute / Blackout).
   */
  public setShutter(closed: boolean): void {
    this.log.info(`[${this.config.host}] Setting Shutter -> ${closed ? 'CLOSED / Blackout (SHU 1)' : 'OPEN (SHU 0)'}`);
    this.state.shutterClosed = closed;
    this.sendRaw(`(SHU ${closed ? 1 : 0})`);
    this.emit('shutterChange', closed);
  }

  public openShutter(): void {
    this.setShutter(false);
  }

  public closeShutter(): void {
    this.setShutter(true);
  }

  public queryShutter(): void {
    this.sendRaw('(SHU?)');
  }

  // --- Input Selection (SIN) & Channels (CHA) ---

  /**
   * Select Active Input Source via `(SIN <id>)`, `(SIN+MAIN <id>)`, `(SIN+PIP <id>)`, or `(CHA <id>)`.
   */
  public setInput(inputId: number | string, subcode?: 'MAIN' | 'PIP' | 'CHA'): void {
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

  public queryInput(): void {
    if (this.config.inputCommandType === 'CHA') {
      this.sendRaw('(CHA?)');
    } else if (this.config.inputCommandType === 'SIN+MAIN') {
      this.sendRaw('(SIN+MAIN?)');
    } else {
      this.sendRaw('(SIN?)');
    }
  }

  /**
   * Select Channel / Preset Source Configuration `(CHA <channelId>)`
   */
  public setChannel(channelId: number | string): void {
    const numId = typeof channelId === 'number' ? channelId : parseInt(String(channelId), 10);
    if (!isNaN(numId)) {
      this.state.currentChannel = numId;
    }
    this.log.info(`[${this.config.host}] Selecting Channel -> (CHA ${channelId})`);
    this.sendRaw(`(CHA ${channelId})`);
  }

  public queryChannel(): void {
    this.sendRaw('(CHA?)');
  }

  // --- Image Freeze (FRZ) ---

  public setFreeze(frozen: boolean): void {
    this.log.info(`[${this.config.host}] Setting Image Freeze -> (FRZ ${frozen ? 1 : 0})`);
    this.state.freeze = frozen;
    this.sendRaw(`(FRZ ${frozen ? 1 : 0})`);
    this.emit('freezeChange', frozen);
  }

  public queryFreeze(): void {
    this.sendRaw('(FRZ?)');
  }

  // --- On-Screen Display (OSD) ---

  public setOsd(visible: boolean): void {
    this.log.info(`[${this.config.host}] Setting On-Screen Display -> (OSD ${visible ? 1 : 0})`);
    this.state.osd = visible;
    this.sendRaw(`(OSD ${visible ? 1 : 0})`);
    this.emit('osdChange', visible);
  }

  public queryOsd(): void {
    this.sendRaw('(OSD?)');
  }

  // --- Picture-in-Picture (PIP / PPS) ---

  public setPip(enabled: boolean): void {
    this.log.info(`[${this.config.host}] Setting Picture-in-Picture -> (PIP ${enabled ? 1 : 0})`);
    this.state.pip = enabled;
    this.sendRaw(`(PIP ${enabled ? 1 : 0})`);
    this.emit('pipChange', enabled);
  }

  public swapPip(): void {
    this.log.info(`[${this.config.host}] Swapping Main & PIP windows -> (PPS 1)`);
    this.sendRaw('(PPS 1)');
  }

  public queryPip(): void {
    this.sendRaw('(PIP?)');
  }

  // --- Internal Test Patterns (ITP) ---

  /**
   * Display an internal test pattern `(ITP <pattern>)` or turn off test pattern `(ITP 0)`.
   */
  public setTestPattern(pattern: number | string): void {
    this.log.info(`[${this.config.host}] Setting Internal Test Pattern -> (ITP ${pattern})`);
    this.state.currentTestPattern = pattern;
    if (typeof pattern === 'number' || /^\d+$/.test(String(pattern))) {
      this.sendRaw(`(ITP ${pattern})`);
    } else {
      const clean = String(pattern).replace(/^"|"$/g, '');
      this.sendRaw(`(ITP "${clean}")`);
    }
    this.emit('testPatternChange', pattern);
  }

  public queryTestPattern(): void {
    this.sendRaw('(ITP?)');
  }

  // --- Lens Control & Intelligent Lens Memory (ILM / ILF / LMS / LCB / ZOM / FCS / LHO / LVO) ---

  public setIntelligentLensMemory(enabled: boolean): void {
    this.log.info(`[${this.config.host}] Setting Intelligent Lens Memory -> (ILM ${enabled ? 1 : 0})`);
    this.sendRaw(`(ILM ${enabled ? 1 : 0})`);
  }

  /**
   * Recalls a saved Lens Memory / ILS file `(ILF <slot>)`.
   */
  public recallLensMemory(slot: number | string, commandCode: 'ILF' | 'LML' | 'SZE' = 'ILF'): void {
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

  public saveLensMemory(slot: number | string): void {
    this.log.info(`[${this.config.host}] Saving Lens Memory -> (LMS ${slot})`);
    this.sendRaw(`(LMS ${slot})`);
  }

  /**
   * Calibrate motorized lens to home reference `(LCB 1)`.
   */
  public calibrateLens(): void {
    this.log.info(`[${this.config.host}] Calibrating Lens to Home -> (LCB 1)`);
    this.sendRaw('(LCB 1)');
  }

  public setZoom(value: number): void {
    this.log.info(`[${this.config.host}] Setting Lens Zoom -> (ZOM ${value})`);
    this.state.zoom = value;
    this.sendRaw(`(ZOM ${value})`);
  }

  public queryZoom(): void {
    this.sendRaw('(ZOM?)');
  }

  public setFocus(value: number): void {
    this.log.info(`[${this.config.host}] Setting Lens Focus -> (FCS ${value})`);
    this.state.focus = value;
    this.sendRaw(`(FCS ${value})`);
  }

  public queryFocus(): void {
    this.sendRaw('(FCS?)');
  }

  public setLensHorizontalShift(value: number): void {
    this.log.info(`[${this.config.host}] Setting Lens Horizontal Shift -> (LHO ${value})`);
    this.state.lensHorizontalShift = value;
    this.sendRaw(`(LHO ${value})`);
  }

  public queryLensHorizontalShift(): void {
    this.sendRaw('(LHO?)');
  }

  public setLensVerticalShift(value: number): void {
    this.log.info(`[${this.config.host}] Setting Lens Vertical Shift -> (LVO ${value})`);
    this.state.lensVerticalShift = value;
    this.sendRaw(`(LVO ${value})`);
  }

  public queryLensVerticalShift(): void {
    this.sendRaw('(LVO?)');
  }

  // --- Image, Aspect Ratio, Geometry & Color Adjustments (BRT / CON / GAM / CLR / SHP / SZE / ASU / KST / WRP / EDG) ---

  public setBrightness(value: number): void {
    this.log.info(`[${this.config.host}] Setting Brightness -> (BRT ${value})`);
    this.state.brightness = value;
    this.sendRaw(`(BRT ${value})`);
  }

  public queryBrightness(): void {
    this.sendRaw('(BRT?)');
  }

  public setContrast(value: number): void {
    this.log.info(`[${this.config.host}] Setting Contrast -> (CON ${value})`);
    this.state.contrast = value;
    this.sendRaw(`(CON ${value})`);
  }

  public queryContrast(): void {
    this.sendRaw('(CON?)');
  }

  public setColorSaturation(value: number): void {
    this.log.info(`[${this.config.host}] Setting Color Saturation -> (CLR ${value})`);
    this.state.colorSaturation = value;
    this.sendRaw(`(CLR ${value})`);
  }

  public queryColorSaturation(): void {
    this.sendRaw('(CLR?)');
  }

  public setSharpness(value: number): void {
    this.log.info(`[${this.config.host}] Setting Sharpness -> (SHP ${value})`);
    this.state.sharpness = value;
    this.sendRaw(`(SHP ${value})`);
  }

  public querySharpness(): void {
    this.sendRaw('(SHP?)');
  }

  public setGamma(value: number | string): void {
    this.log.info(`[${this.config.host}] Setting Gamma -> (GAM ${value})`);
    this.state.gamma = value;
    this.sendRaw(`(GAM ${value})`);
  }

  public queryGamma(): void {
    this.sendRaw('(GAM?)');
  }

  public setSizeMode(mode: number | string): void {
    const numMode = typeof mode === 'number' ? mode : parseInt(String(mode), 10);
    if (!isNaN(numMode)) {
      this.state.currentSizeMode = numMode;
    }
    this.log.info(`[${this.config.host}] Setting Aspect / Size Mode -> (SZE ${mode})`);
    this.sendRaw(`(SZE ${mode})`);
  }

  public querySizeMode(): void {
    this.sendRaw('(SZE?)');
  }

  /**
   * Execute Auto Image Setup `(ASU 1)`
   */
  public triggerAutoSetup(): void {
    this.log.info(`[${this.config.host}] Executing Auto Setup -> (ASU 1)`);
    this.sendRaw('(ASU 1)');
  }

  public setKeystone(value: number): void {
    this.log.info(`[${this.config.host}] Setting Keystone -> (KST ${value})`);
    this.state.keystone = value;
    this.sendRaw(`(KST ${value})`);
  }

  public queryKeystone(): void {
    this.sendRaw('(KST?)');
  }

  public setWarpMap(slot: number): void {
    this.log.info(`[${this.config.host}] Selecting Warp Map -> (WRP ${slot})`);
    this.state.warpMap = slot;
    this.sendRaw(`(WRP ${slot})`);
  }

  public queryWarpMap(): void {
    this.sendRaw('(WRP?)');
  }

  public setEdgeBlend(slot: number): void {
    this.log.info(`[${this.config.host}] Selecting Edge Blend -> (EDG ${slot})`);
    this.state.edgeBlend = slot;
    this.sendRaw(`(EDG ${slot})`);
  }

  public queryEdgeBlend(): void {
    this.sendRaw('(EDG?)');
  }

  // --- Laser / Lamp Power & Hours (LPW / LPM / LPH) ---

  public setLightPower(percentage: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(percentage)));
    this.log.info(`[${this.config.host}] Setting Laser/Lamp Power -> (LPW ${clamped})`);
    this.state.lightPower = clamped;
    this.sendRaw(`(LPW ${clamped})`);
    this.emit('lightPowerChange', clamped);
  }

  public queryLightPower(): void {
    this.sendRaw('(LPW?)');
  }

  public setLightMode(mode: number): void {
    this.log.info(`[${this.config.host}] Setting Light Source Mode -> (LPM ${mode})`);
    this.sendRaw(`(LPM ${mode})`);
  }

  public queryLampHours(): void {
    this.sendRaw('(LPH?)');
  }

  // --- IR / Keypad Emulation (KEY) ---

  public sendKey(keyCode: number | string): void {
    this.log.debug(`[${this.config.host}] Sending Keypad Code -> (KEY ${keyCode})`);
    this.sendRaw(`(KEY ${keyCode})`);
  }

  // --- System Status & Diagnostics (SST / PIF / UID / ERR) ---

  public querySystemStatus(): void {
    this.sendRaw('(SST?)');
  }

  public queryProjectorInfo(): void {
    this.sendRaw('(PIF?)');
    this.sendRaw('(UID?)');
  }

  public queryErrors(): void {
    this.sendRaw('(ERR?)');
  }

  // --- Wake On Lan Implementation ---

  private sendWakeOnLan(macAddress: string): Promise<void> {
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
        socket.close();
        reject(err);
      });

      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err9) => {
          socket.send(magicPacket, 0, magicPacket.length, 7, '255.255.255.255', (err7) => {
            socket.close();
            if (err9 || err7) {
              reject(err9 || err7);
            } else {
              resolve();
            }
          });
        });
      });
    });
  }
}
