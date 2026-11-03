import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
export declare class ChristieProjectorPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    private readonly clients;
    constructor(log: Logger, config: PlatformConfig, api: API);
    /**
     * Restores cached bridged accessories from disk at startup.
     */
    configureAccessory(accessory: PlatformAccessory): void;
    /**
     * Discovers and initializes configured Christie Digital projectors.
     */
    discoverDevices(): void;
}
