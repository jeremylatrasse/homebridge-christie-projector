import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings';
import { ChristieClient } from './christieClient';
import {
  ChristieProjectorAccessory,
  ChristieDeviceConfig,
  sanitizeHomeKitName,
} from './platformAccessory';

export class ChristieProjectorPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly clients: Map<string, ChristieClient> = new Map();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.info(
      `Initializing ${PLATFORM_NAME} v${PLUGIN_VERSION} platform (${this.config.name || 'Christie Projector'})...`,
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
    const rawDevices: ChristieDeviceConfig[] = Array.isArray(this.config.devices)
      ? (this.config.devices as ChristieDeviceConfig[])
      : [];

    const validDevices: ChristieDeviceConfig[] = [];

    for (const raw of rawDevices) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }

      const host = typeof raw.host === 'string' ? raw.host.trim() : '';
      if (host) {
        validDevices.push({
          ...raw,
          host,
        });
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

    const devices: ChristieDeviceConfig[] = [];

    if (validDevices.length > 0) {
      devices.push(...validDevices);
    } else if (typeof this.config.host === 'string' && this.config.host.trim().length > 0) {
      devices.push({
        name: this.config.name || 'Christie Projector',
        host: this.config.host.trim(),
        port: this.config.port,
        mac: this.config.mac,
        pollInterval: this.config.pollInterval ?? this.config.interval,
        cooldownGraceSeconds: this.config.cooldownGraceSeconds,
        treatCode10AsOn: this.config.treatCode10AsOn,
        inputCommandType: this.config.inputCommandType,
        onCommand: this.config.onCommand,
        offCommand: this.config.offCommand,
        stateCommand: this.config.stateCommand,
        enablePowerSwitch: this.config.enablePowerSwitch,
        enableShutterSwitch: this.config.enableShutterSwitch,
        enableFreezeSwitch: this.config.enableFreezeSwitch,
        enableOsdSwitch: this.config.enableOsdSwitch,
        enablePipSwitch: this.config.enablePipSwitch,
        enableAutoSetupSwitch: this.config.enableAutoSetupSwitch,
        enableLensCalibrateSwitch: this.config.enableLensCalibrateSwitch,
        enableLightPowerSlider: this.config.enableLightPowerSlider,
        lightSliderType: this.config.lightSliderType,
        inputs: this.config.inputs,
        channels: this.config.channels,
        lensPresets: this.config.lensPresets,
        testPatterns: this.config.testPatterns,
        customCommands: this.config.customCommands,
      });
    }

    if (devices.length === 0) {
      this.log.warn('No Christie projectors configured in config.json.');
    }

    // Remove any legacy cached bridged accessories from previous configurations
    if (this.accessories.length > 0) {
      this.log.info(`Removing ${this.accessories.length} legacy cached bridged accessory(ies)...`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
      this.accessories.length = 0;
    }

    for (const device of devices) {
      const deviceName = sanitizeHomeKitName(device.name || 'Christie Projector', 'Christie Projector');
      const port = device.port || 3002;

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

      this.clients.set(device.host, client);
      client.start();

      // Publish 1 unified external Television/Projector accessory containing the Projector,
      // named Input Sources, and optional Shutter/Freeze/OSD/PIP/Lens/Pattern switches.
      const uuid = this.api.hap.uuid.generate(`christie-projector-${device.host}:${port}`);
      const accessory = new this.api.platformAccessory(
        deviceName,
        uuid,
        this.api.hap.Categories.TELEVISION,
      );

      new ChristieProjectorAccessory(this, accessory, client, {
        ...device,
        name: deviceName,
      });

      this.log.info(`Publishing Christie Projector accessory: ${deviceName} (${device.host}:${port})`);
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    }
  }
}
