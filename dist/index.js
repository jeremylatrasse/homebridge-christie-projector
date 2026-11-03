"use strict";
const settings_1 = require("./settings");
const platform_1 = require("./platform");
/**
 * Entry point for Homebridge to load the plugin.
 */
const init = (api) => {
    api.registerPlatform(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, platform_1.ChristieProjectorPlatform);
};
module.exports = init;
//# sourceMappingURL=index.js.map