import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ChristieProjectorPlatform } from './platform';
import { ChristieClient } from './christieClient';
import { PLUGIN_VERSION } from './settings';

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
export function sanitizeHomeKitName(rawName: string, fallback = 'Christie Control'): string {
  const cleaned = rawName
    .replace(/\+/g, ' and ')
    .replace(/[()[\]{}/\\:]/g, ' ')
    .replace(/[^a-zA-Z0-9 '-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '');

  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

/**
 * Checks whether an input, channel, lens preset, or test pattern entry has a valid
 * user-provided name and is not an unnamed placeholder.
 */
export function isExplicitlyNamed(rawName?: string): boolean {
  if (!rawName) {
    return false;
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(switch|preset|profile|input|channel|lens|pattern|unnamed|empty|none)\s*#?\d*$/i.test(trimmed)) {
    return false;
  }
  return true;
}

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
export class ChristieProjectorAccessory {
  private tvService: Service;
  private powerSwitchService?: Service;
  private shutterSwitchService?: Service;
  private freezeSwitchService?: Service;
  private osdSwitchService?: Service;
  private pipSwitchService?: Service;
  private autoSetupSwitchService?: Service;
  private lensCalibrateSwitchService?: Service;
  private lightPowerSliderService?: Service;

  private inputServices: Map<number, Service> = new Map();
  private inputSubcodes: Map<number, 'SIN' | 'SIN+MAIN' | 'SIN+PIP' | 'CHA'> = new Map();
  private channelSwitchServices: Map<number, Service> = new Map();
  private lensPresetSwitchServices: Map<number, Service> = new Map();
  private testPatternSwitchServices: Map<string, Service> = new Map();
  private customCommandSwitchServices: Map<string, Service> = new Map();

  constructor(
    private readonly platform: ChristieProjectorPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: ChristieClient,
    private readonly deviceConfig: ChristieDeviceConfig,
  ) {
    const { Service, Characteristic } = this.platform;
    const cleanName = sanitizeHomeKitName(this.deviceConfig.name, 'Christie Projector');

    // 1. Accessory Information
    const infoService = this.accessory.getService(Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(Characteristic.Name, cleanName)
      .setCharacteristic(Characteristic.Manufacturer, 'Christie Digital')
      .setCharacteristic(Characteristic.Model, 'Christie Projector')
      .setCharacteristic(Characteristic.SerialNumber, `CHRISTIE-${this.deviceConfig.host}`)
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    // 2. Primary Television / Projector Service
    this.tvService =
      this.accessory.getService(Service.Television) ||
      this.accessory.addService(Service.Television, cleanName, 'christie-projector');
    this.tvService.setPrimaryService(true);

    this.tvService
      .setCharacteristic(Characteristic.Name, cleanName)
      .setCharacteristic(Characteristic.ConfiguredName, cleanName)
      .setCharacteristic(
        Characteristic.SleepDiscoveryMode,
        Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
      );

    this.tvService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => {
        return this.client.state.power
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE;
      })
      .onSet(async (value: CharacteristicValue) => {
        const targetActive = value === Characteristic.Active.ACTIVE;
        this.platform.log.info(`[${cleanName}] HomeKit Power set -> ${targetActive ? 'ON' : 'OFF'}`);
        if (targetActive) {
          await this.client.powerOn();
        } else {
          this.client.powerOff();
        }
      });

    this.tvService
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.client.state.currentInput ?? 1)
      .onSet((value: CharacteristicValue) => {
        const inputId = Number(value);
        const cmdType = this.inputSubcodes.get(inputId);
        this.platform.log.info(`[${cleanName}] HomeKit Input selected -> ${inputId}`);
        if (cmdType === 'CHA') {
          this.client.setInput(inputId, 'CHA');
        } else if (cmdType === 'SIN+PIP') {
          this.client.setInput(inputId, 'PIP');
        } else if (cmdType === 'SIN+MAIN') {
          this.client.setInput(inputId, 'MAIN');
        } else {
          this.client.setInput(inputId);
        }
      });

    // Map iOS Remote widget D-Pad & Menu keys to Christie (KEY ...) / (OSD ...) / (FRZ ...)
    this.tvService
      .getCharacteristic(Characteristic.RemoteKey)
      .onSet((value: CharacteristicValue) => {
        this.handleRemoteKey(cleanName, value as number);
      });

    // Remove any unused TelevisionSpeaker service
    const existingSpeaker = this.accessory.getService(Service.TelevisionSpeaker);
    if (existingSpeaker) {
      this.tvService.removeLinkedService(existingSpeaker);
      this.accessory.removeService(existingSpeaker);
    }

    // 3. Setup Explicitly Named Input Sources in the Projector's Input Picker
    this.setupInputSources();

    // 4. Setup In-Room Light Power Slider & Control Switches
    // IMPORTANT: Do NOT call tvService.addLinkedService() on Switch/Lightbulb/Fan services
    // so iOS Home.app displays their tiles properly in the room!
    this.setupLightPowerSlider(cleanName);
    this.setupSwitches(cleanName);

    // 5. Subscribe to Live Client Events
    this.subscribeClientEvents();
  }

  private handleRemoteKey(cleanName: string, key: number): void {
    const { Characteristic } = this.platform;
    switch (key) {
      case Characteristic.RemoteKey.ARROW_UP:
        this.client.sendKey(38);
        break;
      case Characteristic.RemoteKey.ARROW_DOWN:
        this.client.sendKey(40);
        break;
      case Characteristic.RemoteKey.ARROW_LEFT:
        this.client.sendKey(37);
        break;
      case Characteristic.RemoteKey.ARROW_RIGHT:
        this.client.sendKey(39);
        break;
      case Characteristic.RemoteKey.SELECT:
        this.client.sendKey(13);
        break;
      case Characteristic.RemoteKey.BACK:
      case Characteristic.RemoteKey.EXIT:
        this.client.sendKey(27);
        break;
      case Characteristic.RemoteKey.INFORMATION:
        this.client.setOsd(!this.client.state.osd);
        break;
      case Characteristic.RemoteKey.PLAY_PAUSE:
        this.client.setFreeze(!this.client.state.freeze);
        break;
      default:
        this.platform.log.debug(`[${cleanName}] Unmapped RemoteKey: ${key}`);
        break;
    }
  }

  private setupInputSources(): void {
    const configuredInputs = (this.deviceConfig.inputs || []).filter((input) =>
      isExplicitlyNamed(input.name),
    );

    for (const [idx, input] of configuredInputs.entries()) {
      const inputId = typeof input.id === 'number' ? input.id : idx + 1;
      this.registerInputSource(inputId, input.name!, input.type, input.commandType);
    }
  }

  private registerInputSource(
    id: number,
    rawName: string,
    type?: string,
    commandType?: 'SIN' | 'SIN+MAIN' | 'SIN+PIP' | 'CHA',
  ): void {
    const { Service, Characteristic } = this.platform;
    const subtype = `input-${id}`;
    const safeName = sanitizeHomeKitName(rawName, `Input ${id}`);

    let hapInputType = Characteristic.InputSourceType.HDMI;
    if (type && type !== 'HDMI') {
      hapInputType = Characteristic.InputSourceType.OTHER;
    }

    let inputService = this.accessory.getServiceById(Service.InputSource, subtype);
    if (!inputService) {
      inputService = new Service.InputSource(safeName, subtype);
      inputService
        .setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.Name, safeName)
        .setCharacteristic(Characteristic.ConfiguredName, safeName)
        .setCharacteristic(
          Characteristic.IsConfigured,
          Characteristic.IsConfigured.CONFIGURED,
        )
        .setCharacteristic(Characteristic.InputSourceType, hapInputType)
        .setCharacteristic(
          Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN,
        );
      this.accessory.addService(inputService);
    } else {
      inputService.displayName = safeName;
      inputService
        .setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.Name, safeName)
        .setCharacteristic(Characteristic.ConfiguredName, safeName)
        .setCharacteristic(
          Characteristic.IsConfigured,
          Characteristic.IsConfigured.CONFIGURED,
        )
        .setCharacteristic(Characteristic.InputSourceType, hapInputType)
        .setCharacteristic(
          Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN,
        );
    }

    this.tvService.addLinkedService(inputService);
    this.inputServices.set(id, inputService);
    if (commandType) {
      this.inputSubcodes.set(id, commandType);
    }
  }

  private createOrUpdateSwitch(subtype: string, rawName: string): Service {
    const { Service, Characteristic } = this.platform;
    const safeName = sanitizeHomeKitName(rawName, 'Christie Switch');

    let svc = this.accessory.getServiceById(Service.Switch, subtype);
    if (!svc) {
      svc = new Service.Switch(safeName, subtype);
      svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      svc.setCharacteristic(Characteristic.Name, safeName);
      svc.setCharacteristic(Characteristic.ConfiguredName, safeName);
      this.accessory.addService(svc);
    } else {
      if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
        svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      }
      svc.displayName = safeName;
      svc.setCharacteristic(Characteristic.Name, safeName);
      svc.setCharacteristic(Characteristic.ConfiguredName, safeName);
      svc.updateCharacteristic(Characteristic.Name, safeName);
      svc.updateCharacteristic(Characteristic.ConfiguredName, safeName);
    }

    return svc;
  }

  private removeSwitchIfPresent(subtype: string): void {
    const { Service } = this.platform;
    const existing = this.accessory.getServiceById(Service.Switch, subtype);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }

  private setupLightPowerSlider(cleanDeviceName: string): void {
    const { Service, Characteristic } = this.platform;
    const fanSubtype = 'christie-light-power-fan';
    const lightSubtype = 'christie-light-power-bulb';

    const enabled =
      Boolean(this.deviceConfig.enableLightPowerSlider) &&
      this.deviceConfig.lightSliderType !== 'none';
    const sliderType = this.deviceConfig.lightSliderType || 'lightbulb';
    const sliderName = sanitizeHomeKitName(`${cleanDeviceName} Laser Power`, 'Projector Laser Power');

    if (!enabled || sliderType !== 'fan') {
      const existingFan = this.accessory.getServiceById(Service.Fan, fanSubtype);
      if (existingFan) {
        this.accessory.removeService(existingFan);
      }
    }
    if (!enabled || sliderType !== 'lightbulb') {
      const existingLight = this.accessory.getServiceById(Service.Lightbulb, lightSubtype);
      if (existingLight) {
        this.accessory.removeService(existingLight);
      }
    }

    if (!enabled) {
      return;
    }

    if (sliderType === 'fan') {
      let fanSvc = this.accessory.getServiceById(Service.Fan, fanSubtype);
      if (!fanSvc) {
        fanSvc = new Service.Fan(sliderName, fanSubtype);
        fanSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        fanSvc.addOptionalCharacteristic(Characteristic.RotationSpeed);
        fanSvc.setCharacteristic(Characteristic.Name, sliderName);
        fanSvc.setCharacteristic(Characteristic.ConfiguredName, sliderName);
        this.accessory.addService(fanSvc);
      } else {
        if (!fanSvc.testCharacteristic(Characteristic.ConfiguredName)) {
          fanSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        if (!fanSvc.testCharacteristic(Characteristic.RotationSpeed)) {
          fanSvc.addOptionalCharacteristic(Characteristic.RotationSpeed);
        }
        fanSvc.displayName = sliderName;
        fanSvc.setCharacteristic(Characteristic.Name, sliderName);
        fanSvc.setCharacteristic(Characteristic.ConfiguredName, sliderName);
      }

      fanSvc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.power && !this.client.state.shutterClosed)
        .onSet((value: CharacteristicValue) => {
          this.client.setShutter(!Boolean(value));
        });

      fanSvc
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() => this.client.state.lightPower)
        .onSet((value: CharacteristicValue) => {
          this.client.setLightPower(Number(value));
        });

      this.lightPowerSliderService = fanSvc;
    } else {
      let lightSvc = this.accessory.getServiceById(Service.Lightbulb, lightSubtype);
      if (!lightSvc) {
        lightSvc = new Service.Lightbulb(sliderName, lightSubtype);
        lightSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        lightSvc.addOptionalCharacteristic(Characteristic.Brightness);
        lightSvc.setCharacteristic(Characteristic.Name, sliderName);
        lightSvc.setCharacteristic(Characteristic.ConfiguredName, sliderName);
        this.accessory.addService(lightSvc);
      } else {
        if (!lightSvc.testCharacteristic(Characteristic.ConfiguredName)) {
          lightSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        if (!lightSvc.testCharacteristic(Characteristic.Brightness)) {
          lightSvc.addOptionalCharacteristic(Characteristic.Brightness);
        }
        lightSvc.displayName = sliderName;
        lightSvc.setCharacteristic(Characteristic.Name, sliderName);
        lightSvc.setCharacteristic(Characteristic.ConfiguredName, sliderName);
      }

      lightSvc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.power && !this.client.state.shutterClosed)
        .onSet((value: CharacteristicValue) => {
          this.client.setShutter(!Boolean(value));
        });

      lightSvc
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.client.state.lightPower)
        .onSet((value: CharacteristicValue) => {
          this.client.setLightPower(Number(value));
        });

      this.lightPowerSliderService = lightSvc;
    }
  }

  private setupSwitches(cleanDeviceName: string): void {
    const { Characteristic } = this.platform;

    // 1. Optional Dedicated Power Switch (for standard switch tile / automations)
    if (this.deviceConfig.enablePowerSwitch) {
      const pwrName = sanitizeHomeKitName(`${cleanDeviceName} Power`, 'Projector Power');
      this.powerSwitchService = this.createOrUpdateSwitch('power-switch', pwrName);
      this.powerSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.power)
        .onSet(async (value: CharacteristicValue) => {
          if (Boolean(value)) {
            await this.client.powerOn();
          } else {
            this.client.powerOff();
          }
        });
    } else {
      this.removeSwitchIfPresent('power-switch');
    }

    // 2. Shutter / Picture Mute (SHU) Switch
    if (this.deviceConfig.enableShutterSwitch !== false) {
      const shuName = sanitizeHomeKitName(`${cleanDeviceName} Shutter`, 'Projector Shutter');
      this.shutterSwitchService = this.createOrUpdateSwitch('shutter-switch', shuName);
      this.shutterSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.shutterClosed)
        .onSet((value: CharacteristicValue) => {
          this.client.setShutter(Boolean(value));
        });
    } else {
      this.removeSwitchIfPresent('shutter-switch');
    }

    // 3. Image Freeze (FRZ) Switch
    if (this.deviceConfig.enableFreezeSwitch) {
      const frzName = sanitizeHomeKitName(`${cleanDeviceName} Freeze`, 'Projector Freeze');
      this.freezeSwitchService = this.createOrUpdateSwitch('freeze-switch', frzName);
      this.freezeSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.freeze)
        .onSet((value: CharacteristicValue) => {
          this.client.setFreeze(Boolean(value));
        });
    } else {
      this.removeSwitchIfPresent('freeze-switch');
    }

    // 4. On-Screen Display (OSD) Switch
    if (this.deviceConfig.enableOsdSwitch) {
      const osdName = sanitizeHomeKitName(`${cleanDeviceName} OSD`, 'Projector OSD');
      this.osdSwitchService = this.createOrUpdateSwitch('osd-switch', osdName);
      this.osdSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.osd)
        .onSet((value: CharacteristicValue) => {
          this.client.setOsd(Boolean(value));
        });
    } else {
      this.removeSwitchIfPresent('osd-switch');
    }

    // 5. Picture-in-Picture (PIP) Switch
    if (this.deviceConfig.enablePipSwitch) {
      const pipName = sanitizeHomeKitName(`${cleanDeviceName} PIP`, 'Projector PIP');
      this.pipSwitchService = this.createOrUpdateSwitch('pip-switch', pipName);
      this.pipSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.pip)
        .onSet((value: CharacteristicValue) => {
          this.client.setPip(Boolean(value));
        });
    } else {
      this.removeSwitchIfPresent('pip-switch');
    }

    // 6. Auto Setup (ASU 1) Momentary Switch
    if (this.deviceConfig.enableAutoSetupSwitch) {
      const asuName = sanitizeHomeKitName(`${cleanDeviceName} Auto Setup`, 'Projector Auto Setup');
      this.autoSetupSwitchService = this.createOrUpdateSwitch('autosetup-switch', asuName);
      this.autoSetupSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value: CharacteristicValue) => {
          if (Boolean(value)) {
            this.client.triggerAutoSetup();
            setTimeout(() => {
              this.autoSetupSwitchService?.updateCharacteristic(Characteristic.On, false);
            }, 300);
          }
        });
    } else {
      this.removeSwitchIfPresent('autosetup-switch');
    }

    // 7. Lens Calibrate / Home (LCB 1) Momentary Switch
    if (this.deviceConfig.enableLensCalibrateSwitch) {
      const lcbName = sanitizeHomeKitName(`${cleanDeviceName} Lens Home`, 'Projector Lens Home');
      this.lensCalibrateSwitchService = this.createOrUpdateSwitch('lens-calibrate-switch', lcbName);
      this.lensCalibrateSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value: CharacteristicValue) => {
          if (Boolean(value)) {
            this.client.calibrateLens();
            setTimeout(() => {
              this.lensCalibrateSwitchService?.updateCharacteristic(Characteristic.On, false);
            }, 300);
          }
        });
    } else {
      this.removeSwitchIfPresent('lens-calibrate-switch');
    }

    // 8. Explicitly Named Channel Switches (CHA)
    const configuredChannels = (this.deviceConfig.channels || []).filter((ch) =>
      isExplicitlyNamed(ch.name),
    );
    for (const [idx, ch] of configuredChannels.entries()) {
      const chId = typeof ch.id === 'number' ? ch.id : idx + 1;
      const subtype = `channel-${chId}`;
      const safeName = sanitizeHomeKitName(ch.name!, `Channel ${chId}`);
      const svc = this.createOrUpdateSwitch(subtype, safeName);

      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.currentChannel === chId)
        .onSet((value: CharacteristicValue) => {
          if (Boolean(value)) {
            this.client.setChannel(chId);
            for (const [otherId, otherSvc] of this.channelSwitchServices.entries()) {
              otherSvc.updateCharacteristic(Characteristic.On, otherId === chId);
            }
          } else if (this.client.state.currentChannel === chId) {
            setTimeout(() => svc.updateCharacteristic(Characteristic.On, true), 150);
          }
        });

      this.channelSwitchServices.set(chId, svc);
    }

    // 9. Explicitly Named Lens Memory / Aspect Ratio Switches (ILF / LML / SZE)
    const configuredLensPresets = (this.deviceConfig.lensPresets || []).filter((lp) =>
      isExplicitlyNamed(lp.name),
    );
    for (const [idx, lp] of configuredLensPresets.entries()) {
      const lpId = typeof lp.id === 'number' ? lp.id : idx + 1;
      const cmdType = lp.commandType || 'ILF';
      const subtype = `lens-preset-${lpId}`;
      const safeName = sanitizeHomeKitName(lp.name!, `Lens ${lpId}`);
      const svc = this.createOrUpdateSwitch(subtype, safeName);

      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.currentLensMemory === lpId)
        .onSet((value: CharacteristicValue) => {
          if (Boolean(value)) {
            this.client.recallLensMemory(lpId, cmdType);
            for (const [otherId, otherSvc] of this.lensPresetSwitchServices.entries()) {
              otherSvc.updateCharacteristic(Characteristic.On, otherId === lpId);
            }
          } else if (this.client.state.currentLensMemory === lpId) {
            setTimeout(() => svc.updateCharacteristic(Characteristic.On, true), 150);
          }
        });

      this.lensPresetSwitchServices.set(lpId, svc);
    }

    // 10. Explicitly Named Test Pattern Switches (ITP)
    const configuredPatterns = (this.deviceConfig.testPatterns || []).filter((tp) =>
      isExplicitlyNamed(tp.name),
    );
    for (const [idx, tp] of configuredPatterns.entries()) {
      const tpId = tp.id !== undefined ? tp.id : idx + 1;
      const key = String(tpId);
      const subtype = `test-pattern-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const safeName = sanitizeHomeKitName(tp.name!, `Test Pattern ${key}`);
      const svc = this.createOrUpdateSwitch(subtype, safeName);

      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => String(this.client.state.currentTestPattern) === key)
        .onSet((value: CharacteristicValue) => {
          if (Boolean(value)) {
            this.client.setTestPattern(tpId);
            for (const [otherKey, otherSvc] of this.testPatternSwitchServices.entries()) {
              otherSvc.updateCharacteristic(Characteristic.On, otherKey === key);
            }
          } else {
            this.client.setTestPattern(0);
          }
        });

      this.testPatternSwitchServices.set(key, svc);
    }

    // 11. Custom Christie Command Switches
    const configuredCustom = (this.deviceConfig.customCommands || []).filter(
      (cmd) => isExplicitlyNamed(cmd.name) && Boolean(cmd.onCommand),
    );
    for (const [idx, cmd] of configuredCustom.entries()) {
      const subtype = `custom-cmd-${idx + 1}`;
      const safeName = sanitizeHomeKitName(cmd.name!, `Christie Command ${idx + 1}`);
      const svc = this.createOrUpdateSwitch(subtype, safeName);

      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.customStates.get(subtype) || false)
        .onSet((value: CharacteristicValue) => {
          const on = Boolean(value);
          if (on) {
            this.client.sendRaw(cmd.onCommand!);
            if (cmd.momentary || !cmd.offCommand) {
              this.client.state.customStates.set(subtype, false);
              setTimeout(() => svc.updateCharacteristic(Characteristic.On, false), 300);
            } else {
              this.client.state.customStates.set(subtype, true);
            }
          } else if (cmd.offCommand) {
            this.client.sendRaw(cmd.offCommand);
            this.client.state.customStates.set(subtype, false);
          }
        });

      this.customCommandSwitchServices.set(subtype, svc);
    }
  }

  private subscribeClientEvents(): void {
    const { Characteristic } = this.platform;

    this.client.on('powerChange', (power: boolean) => {
      this.tvService.updateCharacteristic(
        Characteristic.Active,
        power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
      if (this.powerSwitchService) {
        this.powerSwitchService.updateCharacteristic(Characteristic.On, power);
      }
      if (this.lightPowerSliderService) {
        this.lightPowerSliderService.updateCharacteristic(
          Characteristic.On,
          power && !this.client.state.shutterClosed,
        );
      }
    });

    this.client.on('shutterChange', (closed: boolean) => {
      if (this.shutterSwitchService) {
        this.shutterSwitchService.updateCharacteristic(Characteristic.On, closed);
      }
      if (this.lightPowerSliderService) {
        this.lightPowerSliderService.updateCharacteristic(
          Characteristic.On,
          this.client.state.power && !closed,
        );
      }
    });

    this.client.on('inputChange', (inputId: number) => {
      if (this.inputServices.has(inputId)) {
        this.tvService.updateCharacteristic(Characteristic.ActiveIdentifier, inputId);
      }
    });

    this.client.on('channelChange', (channelId: number) => {
      for (const [id, svc] of this.channelSwitchServices.entries()) {
        svc.updateCharacteristic(Characteristic.On, id === channelId);
      }
    });

    this.client.on('freezeChange', (frozen: boolean) => {
      if (this.freezeSwitchService) {
        this.freezeSwitchService.updateCharacteristic(Characteristic.On, frozen);
      }
    });

    this.client.on('osdChange', (visible: boolean) => {
      if (this.osdSwitchService) {
        this.osdSwitchService.updateCharacteristic(Characteristic.On, visible);
      }
    });

    this.client.on('pipChange', (enabled: boolean) => {
      if (this.pipSwitchService) {
        this.pipSwitchService.updateCharacteristic(Characteristic.On, enabled);
      }
    });

    this.client.on('lensMemoryChange', (slot: number) => {
      for (const [id, svc] of this.lensPresetSwitchServices.entries()) {
        svc.updateCharacteristic(Characteristic.On, id === slot);
      }
    });

    this.client.on('testPatternChange', (val: number | string) => {
      const activeKey = String(val);
      for (const [key, svc] of this.testPatternSwitchServices.entries()) {
        svc.updateCharacteristic(Characteristic.On, key === activeKey && activeKey !== '0');
      }
    });

    this.client.on('lightPowerChange', (percent: number) => {
      if (this.lightPowerSliderService) {
        if (this.lightPowerSliderService.testCharacteristic(Characteristic.RotationSpeed)) {
          this.lightPowerSliderService.updateCharacteristic(Characteristic.RotationSpeed, percent);
        } else if (this.lightPowerSliderService.testCharacteristic(Characteristic.Brightness)) {
          this.lightPowerSliderService.updateCharacteristic(Characteristic.Brightness, percent);
        }
      }
    });

    this.client.on('projectorInfo', (model: string) => {
      const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
      if (infoService && model) {
        infoService.updateCharacteristic(Characteristic.Model, model.slice(0, 64));
      }
    });
  }
}
