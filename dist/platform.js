"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChristieProjectorPlatform = void 0;
exports.normalizePlatformConfig = normalizePlatformConfig;
const settings_1 = require("./settings");
const christieClient_1 = require("./christieClient");
const platformAccessory_1 = require("./platformAccessory");
function normalizePort(rawPort) {
    if (typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535) {
        return Math.floor(rawPort);
    }
    return settings_1.CHRISTIE_DEFAULT_PORT;
}
function normalizePlatformConfig(config) {
    const platformName = typeof config.name === 'string' && config.name.trim().length > 0
        ? config.name.trim()
        : 'Christie Projector';
    const rawDevices = Array.isArray(config.devices)
        ? config.devices
        : [];
    const devices = rawDevices
        .filter((d) => Boolean(d && typeof d === 'object'))
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
            mac: config.mac,
            pollInterval: (config.pollInterval ?? config.interval),
            cooldownGraceSeconds: config.cooldownGraceSeconds,
            treatCode10AsOn: config.treatCode10AsOn,
            inputCommandType: config.inputCommandType,
            onCommand: config.onCommand,
            offCommand: config.offCommand,
            stateCommand: config.stateCommand,
            enablePowerSwitch: config.enablePowerSwitch,
            enableShutterSwitch: config.enableShutterSwitch,
            enableFreezeSwitch: config.enableFreezeSwitch,
            enableOsdSwitch: config.enableOsdSwitch,
            enablePipSwitch: config.enablePipSwitch,
            enableAutoSetupSwitch: config.enableAutoSetupSwitch,
            enableLensCalibrateSwitch: config.enableLensCalibrateSwitch,
            enableLightPowerSlider: config.enableLightPowerSlider,
            lightSliderType: config.lightSliderType,
            inputs: config.inputs,
            channels: config.channels,
            lensPresets: config.lensPresets,
            testPatterns: config.testPatterns,
            customCommands: config.customCommands,
        });
    }
    return {
        name: platformName,
        devices,
    };
}
class ChristieProjectorPlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    accessories = [];
    clients = new Map();
    normalizedConfig;
    registeredPlatformName;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.normalizedConfig = normalizePlatformConfig(this.config);
        this.registeredPlatformName = this.config.platform
            ? String(this.config.platform).split('.').pop() || settings_1.PLATFORM_NAME
            : settings_1.PLATFORM_NAME;
        this.log.info(`Initializing ${settings_1.PLATFORM_NAME} v${settings_1.PLUGIN_VERSION} platform (${this.normalizedConfig.name})...`);
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
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.push(accessory);
    }
    /**
     * Discovers and initializes configured Christie Digital projectors.
     */
    discoverDevices() {
        const validDevices = [];
        for (const raw of this.normalizedConfig.devices) {
            const host = raw.host;
            if (host) {
                const validation = (0, christieClient_1.validateChristieHost)(host);
                if (!validation.valid) {
                    this.log.error(`Skipping Christie device "${raw.name || host}" — ${validation.reason}`);
                    continue;
                }
                validDevices.push(raw);
            }
            else {
                const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
                const isCustomDevice = (rawName !== '' && rawName !== 'Christie Projector') ||
                    Boolean(raw.mac) ||
                    Boolean(raw.inputs?.length) ||
                    Boolean(raw.channels?.length) ||
                    Boolean(raw.lensPresets?.length) ||
                    Boolean(raw.testPatterns?.length) ||
                    Boolean(raw.customCommands?.length);
                if (isCustomDevice) {
                    this.log.warn(`Skipping Christie device "${rawName || 'Unknown'}" because no host/IP is configured.`);
                }
                else {
                    this.log.debug('Ignoring unconfigured Christie device placeholder with no host/IP.');
                }
            }
        }
        // Remove any legacy cached bridged accessories from previous configurations
        if (this.accessories.length > 0) {
            this.log.info(`Removing ${this.accessories.length} legacy cached bridged accessory(ies)...`);
            try {
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, this.registeredPlatformName, this.accessories);
            }
            catch (err) {
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
            const deviceName = (0, platformAccessory_1.sanitizeHomeKitName)(device.name || 'Christie Projector', 'Christie Projector');
            const port = device.port || settings_1.CHRISTIE_DEFAULT_PORT;
            const client = new christieClient_1.ChristieClient({
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
            }, this.log);
            this.clients.set(`${device.host}:${port}`, client);
            client.start();
            // Publish 1 unified external Television/Projector accessory containing the Projector,
            // named Input Sources, and optional Shutter/Freeze/OSD/PIP/Lens/Pattern switches.
            // Keep UUID seed unchanged so Apple Home room assignments and scenes remain stable.
            const uuid = this.api.hap.uuid.generate(`christie-projector-${device.host}:${port}`);
            const accessory = new this.api.platformAccessory(deviceName, uuid, 31 /* this.api.hap.Categories.TELEVISION */);
            new platformAccessory_1.ChristieProjectorAccessory(this, accessory, client, {
                ...device,
                name: deviceName,
                port,
            });
            try {
                this.log.info(`Publishing Christie Projector accessory: ${deviceName} (${device.host}:${port})`);
                this.api.publishExternalAccessories(settings_1.PLUGIN_NAME, [accessory]);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.error(`[${deviceName}] Failed to publish Christie Projector accessory: ${msg}`);
            }
        }
    }
}
exports.ChristieProjectorPlatform = ChristieProjectorPlatform;
//# sourceMappingURL=platform.js.map