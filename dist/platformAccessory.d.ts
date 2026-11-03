import { PlatformAccessory } from 'homebridge';
import { ChristieProjectorPlatform } from './platform';
import { ChristieClient } from './christieClient';
export interface InputSourceConfig {
    id?: number;
    name?: string;
    type?: 'HDMI' | 'DVI' | 'DISPLAYPORT' | 'SDI' | 'HDBASET' | 'OTHER';
    commandType?: 'SIN' | 'SIN+MAIN' | 'SIN+PIP' | 'CHA';
}
export interface ChannelPresetConfig {
    id?: number;
    name?: string;
}
export interface LensPresetConfig {
    id?: number;
    name?: string;
    commandType?: 'ILF' | 'LML' | 'SZE';
}
export interface TestPatternConfig {
    id?: number | string;
    name?: string;
}
export interface CustomCommandSwitchConfig {
    name?: string;
    onCommand?: string;
    offCommand?: string;
    momentary?: boolean;
}
export interface ChristieDeviceConfig {
    name: string;
    host: string;
    port?: number;
    mac?: string;
    pollInterval?: number;
    cooldownGraceSeconds?: number;
    treatCode10AsOn?: boolean;
    inputCommandType?: 'SIN' | 'SIN+MAIN' | 'CHA';
    onCommand?: string;
    offCommand?: string;
    stateCommand?: string;
    enablePowerSwitch?: boolean;
    enableShutterSwitch?: boolean;
    enableFreezeSwitch?: boolean;
    enableOsdSwitch?: boolean;
    enablePipSwitch?: boolean;
    enableAutoSetupSwitch?: boolean;
    enableLensCalibrateSwitch?: boolean;
    enableLightPowerSlider?: boolean;
    lightSliderType?: 'lightbulb' | 'fan' | 'none';
    inputs?: InputSourceConfig[];
    channels?: ChannelPresetConfig[];
    lensPresets?: LensPresetConfig[];
    testPatterns?: TestPatternConfig[];
    customCommands?: CustomCommandSwitchConfig[];
}
/**
 * Sanitizes any string into a valid Apple HomeKit HAP Name:
 * - Must start and end with a letter or number
 * - Only letters, numbers, spaces, apostrophes, and hyphens allowed
 * - Removes parentheses, pluses, slashes, colons, etc. that trigger HAP-NodeJS warnings
 */
export declare function sanitizeHomeKitName(rawName: string, fallback?: string): string;
/**
 * Checks whether an input, channel, lens preset, or test pattern entry has a valid
 * user-provided name and is not an unnamed placeholder.
 */
export declare function isExplicitlyNamed(rawName?: string): boolean;
/**
 * Unified Christie Digital Projector Accessory:
 *
 * Exposes:
 * - Service.Television (`TELEVISION`): Power `(PWR 1)` / `(PWR 0)`, Input Picker `(SIN)` / `(CHA)`, and RemoteKey `(KEY)`
 * - Service.InputSource: Explicitly named Christie inputs/channels
 * - Optional in-room switches & sliders:
 *   - Shutter / Picture Mute `(SHU 1)` / `(SHU 0)`
 *   - Image Freeze `(FRZ 1)` / `(FRZ 0)`
 *   - On-Screen Display `(OSD 1)` / `(OSD 0)`
 *   - Picture-in-Picture `(PIP 1)` / `(PIP 0)`
 *   - Auto Setup `(ASU 1)` & Lens Calibrate `(LCB 1)`
 *   - Laser / Lamp Power Slider `(LPW 0..100)`
 *   - Named Channel switches `(CHA <id>)`
 *   - Named Lens Memory / Aspect Ratio switches `(ILF <id>)` / `(SZE <id>)`
 *   - Named Test Pattern switches `(ITP <id>)` / `(ITP 0)`
 *   - Custom Command switches
 */
export declare class ChristieProjectorAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly client;
    private readonly deviceConfig;
    private tvService;
    private powerSwitchService?;
    private shutterSwitchService?;
    private freezeSwitchService?;
    private osdSwitchService?;
    private pipSwitchService?;
    private autoSetupSwitchService?;
    private lensCalibrateSwitchService?;
    private lightPowerSliderService?;
    private inputServices;
    private inputSubcodes;
    private channelSwitchServices;
    private lensPresetSwitchServices;
    private testPatternSwitchServices;
    private customCommandSwitchServices;
    constructor(platform: ChristieProjectorPlatform, accessory: PlatformAccessory, client: ChristieClient, deviceConfig: ChristieDeviceConfig);
    private handleRemoteKey;
    private setupInputSources;
    private registerInputSource;
    private createOrUpdateSwitch;
    private removeSwitchIfPresent;
    private setupLightPowerSlider;
    private setupSwitches;
    private subscribeClientEvents;
}
