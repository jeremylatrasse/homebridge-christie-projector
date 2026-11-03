import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Name of the platform registered in Homebridge.
 * This must match the platform name used in config.json and config.schema.json.
 */
export const PLATFORM_NAME = 'ChristieProjector';

/**
 * Name of the npm package.
 * This must match the name in package.json.
 */
export const PLUGIN_NAME = 'homebridge-christie-projector';

/**
 * Reads the current plugin version from package.json dynamically so
 * Homebridge logs and HomeKit FirmwareRevision always match package.json.
 */
function loadPluginVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export const PLUGIN_VERSION = loadPluginVersion();
