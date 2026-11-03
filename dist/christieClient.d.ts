import { EventEmitter } from 'events';
export type ChristiePowerStatus = 'OFF' | 'ON' | 'COOLING' | 'WARMING' | 'AUTO_SHUTDOWN' | 'EMERGENCY_SHUTDOWN';
export interface ChristieClientConfig {
    host: string;
    port?: number;
    mac?: string;
    pollInterval?: number;
    reconnectInterval?: number;
    socketTimeoutMs?: number;
    cooldownGraceSeconds?: number;
    treatCode10AsOn?: boolean;
    inputCommandType?: 'SIN' | 'SIN+MAIN' | 'CHA';
    onCommand?: string;
    offCommand?: string;
    stateCommand?: string;
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
    lightPower: number;
    brightness: number;
    contrast: number;
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
/**
 * Validates that an IPv4 address has exactly 4 octets between 0 and 255.
 * Also permits standard RFC 1123 hostnames (e.g. christie.local).
 */
export declare function validateChristieHost(host: string): {
    valid: boolean;
    reason?: string;
};
export declare class ChristieClient extends EventEmitter {
    private readonly log;
    private socket;
    private isConnecting;
    private isDestroyed;
    private buffer;
    private commandQueue;
    private reconnectTimer?;
    private pollTimer?;
    private transitionTimer?;
    private connectTimeoutTimer?;
    private powerTransitionTarget;
    private powerTransitionUntil;
    private awaitingResponse;
    private lastDataReceivedAt;
    private lastProbeSentAt;
    private heartbeatActive;
    private expectedPowerState;
    private heartbeatLogState;
    private onCommandSentAt;
    readonly config: Required<ChristieClientConfig>;
    state: ChristieState;
    constructor(config: ChristieClientConfig, log: LoggerLike);
    start(): void;
    stop(): void;
    restart(): void;
    private clearTimers;
    private beginHeartbeatProbing;
    private recordHeartbeatSuccess;
    private recordHeartbeatFailure;
    isConnected(): boolean;
    /**
     * Formats a Christie ASCII command ensuring enclosing parentheses `(...)`.
     */
    static formatCommand(rawCommand: string): string;
    /**
     * Sends a one-shot query/command over a dedicated short-lived TCP connection
     * (equivalent to `printf '(PWR?)\r\n' | nc -w 3 <host> 3002`) and resolves with the reply.
     */
    sendOneShot(rawCommand: string, timeoutMs?: number): Promise<string>;
    /**
     * Actively probes whether the Christie projector is responding on port 3002.
     */
    checkIfResponding(timeoutMs?: number): Promise<boolean>;
    private connect;
    private disconnect;
    private handleSocketClose;
    private startPolling;
    /**
     * Polls the projector for current power, shutter, and input/channel states.
     */
    pollStatus(): void;
    private markUnitResponding;
    /**
     * Extracts both parenthesized Christie frames `(CMD!...)` and newline-delimited messages.
     * Christie projectors often send `(PWR!001)` or `(PWR!10)` without a trailing newline,
     * or multiple parenthesized tokens back-to-back.
     */
    handleIncomingData(chunk: string): void;
    private processLine;
    private processFrame;
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
    private parseToken;
    /**
     * Interprets Christie `PWR!` status codes:
     * - `0` / `00` / `000`: Standby / Power Off
     * - `1` / `01` / `001`: Power On (Lamp/Laser On)
     * - `10` / `010`: Cooling Down (or Active/On in setups matching `PWR!10` when not cooling down from powerOff)
     * - `11` / `011`: Warming Up
     * - `20`..`23` / `020`..`023`: AutoShutdown / Emergency Shutdown
     */
    private handlePowerReply;
    private writeToSocket;
    /**
     * Sends a Christie command (automatically wrapped in parentheses if not already).
     * If the TCP socket is disconnected, queues the command and initiates connection immediately.
     */
    sendRaw(rawCommand: string): void;
    /**
     * Power On: Sends `(PWR 1)` (or configured `onCommand`), plus optional Wake-on-LAN if `mac` is set.
     */
    powerOn(): Promise<void>;
    /**
     * Power Off: Sends `(PWR 0)` (or configured `offCommand`).
     */
    powerOff(): void;
    private scheduleTransitionCheck;
    /**
     * Query Power State `(PWR?)`
     */
    queryPower(): void;
    /**
     * Set Standby Mode:
     * - `1` = Communication Mode (keeps Ethernet / RS-232 port 3002 active during standby)
     * - `0` = Low Power Eco Mode (0.5W)
     */
    setStandbyMode(communicationMode: boolean): void;
    /**
     * Keep video electronics active in standby `(PWR+ELEC 1/0)`
     */
    setStandbyElectronics(enabled: boolean): void;
    /**
     * Open `(SHU 0)` or Close `(SHU 1)` the shutter (Picture Mute / Blackout).
     */
    setShutter(closed: boolean): void;
    openShutter(): void;
    closeShutter(): void;
    queryShutter(): void;
    /**
     * Select Active Input Source via `(SIN <id>)`, `(SIN+MAIN <id>)`, `(SIN+PIP <id>)`, or `(CHA <id>)`.
     */
    setInput(inputId: number | string, subcode?: 'MAIN' | 'PIP' | 'CHA'): void;
    queryInput(): void;
    /**
     * Select Channel / Preset Source Configuration `(CHA <channelId>)`
     */
    setChannel(channelId: number | string): void;
    queryChannel(): void;
    setFreeze(frozen: boolean): void;
    queryFreeze(): void;
    setOsd(visible: boolean): void;
    queryOsd(): void;
    setPip(enabled: boolean): void;
    swapPip(): void;
    queryPip(): void;
    /**
     * Display an internal test pattern `(ITP <pattern>)` or turn off test pattern `(ITP 0)`.
     */
    setTestPattern(pattern: number | string): void;
    queryTestPattern(): void;
    setIntelligentLensMemory(enabled: boolean): void;
    /**
     * Recalls a saved Lens Memory / ILS file `(ILF <slot>)`.
     */
    recallLensMemory(slot: number | string, commandCode?: 'ILF' | 'LML' | 'SZE'): void;
    saveLensMemory(slot: number | string): void;
    /**
     * Calibrate motorized lens to home reference `(LCB 1)`.
     */
    calibrateLens(): void;
    setZoom(value: number): void;
    queryZoom(): void;
    setFocus(value: number): void;
    queryFocus(): void;
    setLensHorizontalShift(value: number): void;
    queryLensHorizontalShift(): void;
    setLensVerticalShift(value: number): void;
    queryLensVerticalShift(): void;
    setBrightness(value: number): void;
    queryBrightness(): void;
    setContrast(value: number): void;
    queryContrast(): void;
    setColorSaturation(value: number): void;
    queryColorSaturation(): void;
    setSharpness(value: number): void;
    querySharpness(): void;
    setGamma(value: number | string): void;
    queryGamma(): void;
    setSizeMode(mode: number | string): void;
    querySizeMode(): void;
    /**
     * Execute Auto Image Setup `(ASU 1)`
     */
    triggerAutoSetup(): void;
    setKeystone(value: number): void;
    queryKeystone(): void;
    setWarpMap(slot: number): void;
    queryWarpMap(): void;
    setEdgeBlend(slot: number): void;
    queryEdgeBlend(): void;
    setLightPower(percentage: number): void;
    queryLightPower(): void;
    setLightMode(mode: number): void;
    queryLampHours(): void;
    sendKey(keyCode: number | string): void;
    querySystemStatus(): void;
    queryProjectorInfo(): void;
    queryErrors(): void;
    sendWakeOnLan(macAddress: string): Promise<void>;
}
