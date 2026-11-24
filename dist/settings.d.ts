/**
 * Name of the platform registered in Homebridge.
 * This must match the platform name used in config.json and config.schema.json.
 */
export declare const PLATFORM_NAME = "ChristieProjector";
/**
 * Name of the npm package.
 * This must match the name in package.json.
 */
export declare const PLUGIN_NAME = "homebridge-christie-projector";
/**
 * Default Christie Digital ASCII Serial-over-Ethernet TCP port.
 */
export declare const CHRISTIE_DEFAULT_PORT = 3002;
/**
 * Reads the current plugin version from package.json dynamically so
 * Homebridge logs and HomeKit FirmwareRevision always match package.json.
 */
export declare function loadPluginVersion(): string;
export declare const PLUGIN_VERSION: string;
