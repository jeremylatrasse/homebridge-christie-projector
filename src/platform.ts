import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import {
  CHRISTIE_DEFAULT_PORT,
  PLATFORM_NAME,
  PLUGIN_NAME,
  PLUGIN_VERSION,
} from './settings';
import { ChristieClient, validateChristieHost } from './christieClient';
import {
  ChristieProjectorAccessory,
  ChristieDeviceConfig,
  sanitizeHomeKitName,
} from './platformAccessory';

export interface NormalizedChristiePlatformConfig {
  name: string;
  devices: ChristieDeviceConfig[];
}

function normalizePort(rawPort: unknown): number {
  if (typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535) {
    return Math.floor(rawPort);
  }
  return CHRISTIE_DEFAULT_PORT;
}

export function normalizePlatformConfig(config: PlatformConfig): NormalizedChristiePlatformConfig {
  const platformName =
    typeof config.name === 'string' && config.name.trim().length > 0
      ? config.name.trim()
      : 'Christie Projector';

  const rawDevices = Array.isArray(config.devices)
    ? (config.devices as ChristieDeviceConfig[])
    : [];

  const devices: ChristieDeviceConfig[] = rawDevices
    .filter((d): d is ChristieDeviceConfig => Boolean(d && typeof d === 'object'))
    .map((d) => ({
      ...d,
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Christie Projector',
      host: typeof d.host === 'string' ? d.host.trim() : '',
      port: normalizePort(d.port),
    }));

  // Support legacy/single-device top-level host configuration when devices[] is empty
  if (devices.length === 0 && typeof config.host === 'string' && config.host.trim().length > 0) {
    devices.push({
      name: platformName,
      host: config.host.trim(),
      port: normalizePort(config.port),
      mac: config.mac as string | undefined,
      pollInterval: (config.pollInterval ?? config.interval) as number | undefined,
      cooldownGraceSeconds: config.cooldownGraceSeconds as number | undefined,
      treatCode10AsOn: config.treatCode10AsOn as boolean | undefined,
      inputCommandType: config.inputCommandType as 'SIN' | 'SIN+MAIN' | 'CHA' | undefined,
      onCommand: config.onCommand as string | undefined,
      offCommand: config.offCommand as string | undefined,
      stateCommand: config.stateCommand as string | undefined,
      enablePowerSwitch: config.enablePowerSwitch as boolean | undefined,
      enableShutterSwitch: config.enableShutterSwitch as boolean | undefined,
      enableFreezeSwitch: config.enableFreezeSwitch as boolean | undefined,
      enableOsdSwitch: config.enableOsdSwitch as boolean | undefined,
      enablePipSwitch: config.enablePipSwitch as boolean | undefined,
      enableAutoSetupSwitch: config.enableAutoSetupSwitch as boolean | undefined,
      enableLensCalibrateSwitch: config.enableLensCalibrateSwitch as boolean | undefined,
      enableLightPowerSlider: config.enableLightPowerSlider as boolean | undefined,
      lightSliderType: config.lightSliderType as 'lightbulb' | 'fan' | 'none' | undefined,
      inputs: config.inputs as ChristieDeviceConfig['inputs'],
      channels: config.channels as ChristieDeviceConfig['channels'],
      lensPresets: config.lensPresets as ChristieDeviceConfig['lensPresets'],
      testPatterns: config.testPatterns as ChristieDeviceConfig['testPatterns'],
      customCommands: config.customCommands as ChristieDeviceConfig['customCommands'],
    });
  }

  return {
    name: platformName,
    devices,
  };
}

export class ChristieProjectorPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly clients: Map<string, ChristieClient> = new Map();
  private readonly normalizedConfig: NormalizedChristiePlatformConfig;
  private readonly registeredPlatformName: string;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.normalizedConfig = normalizePlatformConfig(this.config);
    this.registeredPlatformName = this.config.platform
      ? String(this.config.platform).split('.').pop() || PLATFORM_NAME
      : PLATFORM_NAME;

    this.log.info(
      `Initializing ${PLATFORM_NAME} v${PLUGIN_VERSION} platform (${this.normalizedConfig.name})...`,
    );

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      this.log.info('Shutting down Christie projector connections...');
      for (const client of this.clients.values()) {
        client.stop();
      }
    });
  }

  /**
   * Restores cached bridged accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Discovers and initializes configured Christie Digital projectors.
   */
  discoverDevices(): void {
    const validDevices: ChristieDeviceConfig[] = [];

    for (const raw of this.normalizedConfig.devices) {
      const host = raw.host;
      if (host) {
        const validation = validateChristieHost(host);
        if (!validation.valid) {
          this.log.error(`Skipping Christie device "${raw.name || host}" — ${validation.reason}`);
          continue;
        }
        validDevices.push(raw);
      } else {
        const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
        const isCustomDevice =
          (rawName !== '' && rawName !== 'Christie Projector') ||
          Boolean(raw.mac) ||
          Boolean(raw.inputs?.length) ||
          Boolean(raw.channels?.length) ||
          Boolean(raw.lensPresets?.length) ||
          Boolean(raw.testPatterns?.length) ||
          Boolean(raw.customCommands?.length);

        if (isCustomDevice) {
          this.log.warn(`Skipping Christie device "${rawName || 'Unknown'}" because no host/IP is configured.`);
        } else {
          this.log.debug('Ignoring unconfigured Christie device placeholder with no host/IP.');
        }
      }
    }

    // Remove any legacy cached bridged accessories from previous configurations
    if (this.accessories.length > 0) {
      this.log.info(`Removing ${this.accessories.length} legacy cached bridged accessory(ies)...`);
      try {
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          this.registeredPlatformName,
          this.accessories,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug(`Failed to unregister legacy cached accessories: ${msg}`);
      }
      this.accessories.length = 0;
    }

    if (validDevices.length === 0) {
      this.log.warn('No Christie projectors configured in config.json.');
      return;
    }

    for (const device of validDevices) {
      const deviceName = sanitizeHomeKitName(device.name || 'Christie Projector', 'Christie Projector');
      const port = device.port || CHRISTIE_DEFAULT_PORT;

      const client = new ChristieClient(
        {
          host: device.host,
          port,
          mac: device.mac,
          pollInterval: device.pollInterval || 10,
          cooldownGraceSeconds: device.cooldownGraceSeconds,
          treatCode10AsOn: device.treatCode10AsOn,
          inputCommandType: device.inputCommandType,
          onCommand: device.onCommand,
          offCommand: device.offCommand,
          stateCommand: device.stateCommand,
        },
        this.log,
      );

      this.clients.set(`${device.host}:${port}`, client);
      client.start();

      // Publish 1 unified external Television/Projector accessory containing the Projector,
      // named Input Sources, and optional Shutter/Freeze/OSD/PIP/Lens/Pattern switches.
      // Keep UUID seed unchanged so Apple Home room assignments and scenes remain stable.
      const uuid = this.api.hap.uuid.generate(`christie-projector-${device.host}:${port}`);
      const accessory = new this.api.platformAccessory(
        deviceName,
        uuid,
        this.api.hap.Categories.TELEVISION,
      );

      new ChristieProjectorAccessory(this, accessory, client, {
        ...device,
        name: deviceName,
        port,
      });

      try {
        this.log.info(`Publishing Christie Projector accessory: ${deviceName} (${device.host}:${port})`);
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`[${deviceName}] Failed to publish Christie Projector accessory: ${msg}`);
      }
    }
  }
}
