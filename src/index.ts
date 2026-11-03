import { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { ChristieProjectorPlatform } from './platform';

/**
 * Entry point for Homebridge to load the plugin.
 */
const init = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ChristieProjectorPlatform);
};

export = init;
