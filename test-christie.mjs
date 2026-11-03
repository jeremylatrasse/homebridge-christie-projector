import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChristieClient, validateChristieHost } from './dist/christieClient.js';
import { sanitizeHomeKitName, isExplicitlyNamed } from './dist/platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './dist/settings.js';
import { ChristieProjectorPlatform } from './dist/platform.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('./config.schema.json', import.meta.url), 'utf8'));

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

console.log('Running ChristieClient & HomeKit Configuration unit tests...');

// 0. Verify dynamic plugin version & settings
assert.equal(PLATFORM_NAME, 'ChristieProjector');
assert.equal(PLUGIN_NAME, 'homebridge-christie-projector');
assert.equal(PLUGIN_VERSION, pkg.version, 'PLUGIN_VERSION must match package.json version');
console.log(`✓ Plugin version verified: v${PLUGIN_VERSION}`);

const client = new ChristieClient(
  {
    host: '172.16.1.247',
    port: 3002,
    pollInterval: 10,
    cooldownGraceSeconds: 5,
    treatCode10AsOn: true,
  },
  mockLog,
);

// 1. Test Power Replies (including (PWR!000), (PWR!001), (PWR!10), (PWR!11))
let powerChangedTo = null;
client.on('powerChange', (p) => {
  powerChangedTo = p;
});

client.handleIncomingData('(PWR!000 "Standby")\r\n');
assert.equal(client.state.power, false);
assert.equal(client.state.powerStatus, 'OFF');

// Standard (PWR!001) -> ON
client.handleIncomingData('(PWR!001 "On")\r\n');
assert.equal(client.state.power, true);
assert.equal(client.state.powerStatus, 'ON');
assert.equal(powerChangedTo, true);

// Reset to OFF
client.handleIncomingData('(PWR!00)\r\n');
assert.equal(client.state.power, false);

// User's state_cmd match: (PWR!10) without trailing newline -> ON when not in cooldown
client.handleIncomingData('(PWR!10)');
assert.equal(client.state.power, true);
assert.equal(client.state.powerStatus, 'ON');

// Warming up (PWR!11) -> ON
client.handleIncomingData('(PWR!11)');
assert.equal(client.state.power, true);
assert.equal(client.state.powerStatus, 'WARMING');

// Explicit "Cooling Down" description -> OFF
client.handleIncomingData('(PWR!010 "Cooling Down")');
assert.equal(client.state.power, false);
assert.equal(client.state.powerStatus, 'COOLING');
console.log('✓ Power status parsing ((PWR!000), (PWR!001), (PWR!10), (PWR!11)) passed');

// 2. Test back-to-back parenthesized frames without newlines
client.handleIncomingData('(SHU!001)(SIN!003)(CHA!102)(FRZ!001)(OSD!000)(PIP!001)(LPW!085)(LPH!01250)');
assert.equal(client.state.shutterClosed, true);
assert.equal(client.state.currentInput, 3);
assert.equal(client.state.currentChannel, 102);
assert.equal(client.state.freeze, true);
assert.equal(client.state.osd, false);
assert.equal(client.state.pip, true);
assert.equal(client.state.lightPower, 85);
assert.equal(client.state.lampHours, 1250);
console.log('✓ Back-to-back parenthesized frame parsing passed');

// 3. Test Command Formatting & All Christie Serial API Commands
const sentCommands = [];
client.socket = {
  destroyed: false,
  write: (data) => sentCommands.push(data),
};
client.isConnecting = false;

await client.powerOn();
assert.equal(sentCommands.pop(), '(PWR 1)\r\n');
assert.equal(client.state.power, true);

client.powerOff();
assert.equal(sentCommands.pop(), '(PWR 0)\r\n');
assert.equal(client.state.power, false);

// While in powerOff cooldown grace window, receiving (PWR!10) must NOT snap power back to ON
client.handleIncomingData('(PWR!10)\r\n');
assert.equal(client.state.power, false, 'Power must remain OFF during cooldown transition even if PWR!10 is received');
client.stop(); // clear transition timer

// Re-attach mock socket for command tests
client.socket = {
  destroyed: false,
  write: (data) => sentCommands.push(data),
};
client.isConnecting = false;

client.queryPower();
assert.equal(sentCommands.pop(), '(PWR?)\r\n');

client.setStandbyMode(true);
assert.equal(sentCommands.pop(), '(PWR+STBM 1)\r\n');

client.setStandbyElectronics(true);
assert.equal(sentCommands.pop(), '(PWR+ELEC 1)\r\n');

client.closeShutter();
assert.equal(sentCommands.pop(), '(SHU 1)\r\n');
assert.equal(client.state.shutterClosed, true);

client.openShutter();
assert.equal(sentCommands.pop(), '(SHU 0)\r\n');
assert.equal(client.state.shutterClosed, false);

client.setInput(2);
assert.equal(sentCommands.pop(), '(SIN 2)\r\n');

client.setInput(4, 'MAIN');
assert.equal(sentCommands.pop(), '(SIN+MAIN 4)\r\n');

client.setInput(5, 'PIP');
assert.equal(sentCommands.pop(), '(SIN+PIP 5)\r\n');

client.setChannel(101);
assert.equal(sentCommands.pop(), '(CHA 101)\r\n');

client.setFreeze(true);
assert.equal(sentCommands.pop(), '(FRZ 1)\r\n');

client.setOsd(false);
assert.equal(sentCommands.pop(), '(OSD 0)\r\n');

client.setPip(true);
assert.equal(sentCommands.pop(), '(PIP 1)\r\n');

client.swapPip();
assert.equal(sentCommands.pop(), '(PPS 1)\r\n');

client.setTestPattern(4);
assert.equal(sentCommands.pop(), '(ITP 4)\r\n');

client.setTestPattern('Grid');
assert.equal(sentCommands.pop(), '(ITP "Grid")\r\n');

client.setIntelligentLensMemory(true);
assert.equal(sentCommands.pop(), '(ILM 1)\r\n');

client.recallLensMemory(2, 'ILF');
assert.equal(sentCommands.pop(), '(ILF 2)\r\n');

client.saveLensMemory(2);
assert.equal(sentCommands.pop(), '(LMS 2)\r\n');

client.calibrateLens();
assert.equal(sentCommands.pop(), '(LCB 1)\r\n');

client.setZoom(120);
assert.equal(sentCommands.pop(), '(ZOM 120)\r\n');

client.setFocus(80);
assert.equal(sentCommands.pop(), '(FCS 80)\r\n');

client.setLensHorizontalShift(15);
assert.equal(sentCommands.pop(), '(LHO 15)\r\n');

client.setLensVerticalShift(-10);
assert.equal(sentCommands.pop(), '(LVO -10)\r\n');

client.setBrightness(52);
assert.equal(sentCommands.pop(), '(BRT 52)\r\n');

client.setContrast(48);
assert.equal(sentCommands.pop(), '(CON 48)\r\n');

client.setColorSaturation(50);
assert.equal(sentCommands.pop(), '(CLR 50)\r\n');

client.setSharpness(55);
assert.equal(sentCommands.pop(), '(SHP 55)\r\n');

client.setGamma(2.4);
assert.equal(sentCommands.pop(), '(GAM 2.4)\r\n');

client.setSizeMode(3);
assert.equal(sentCommands.pop(), '(SZE 3)\r\n');

client.triggerAutoSetup();
assert.equal(sentCommands.pop(), '(ASU 1)\r\n');

client.setKeystone(5);
assert.equal(sentCommands.pop(), '(KST 5)\r\n');

client.setWarpMap(1);
assert.equal(sentCommands.pop(), '(WRP 1)\r\n');

client.setEdgeBlend(2);
assert.equal(sentCommands.pop(), '(EDG 2)\r\n');

client.setLightPower(90);
assert.equal(sentCommands.pop(), '(LPW 90)\r\n');

client.setLightMode(1);
assert.equal(sentCommands.pop(), '(LPM 1)\r\n');

client.queryLampHours();
assert.equal(sentCommands.pop(), '(LPH?)\r\n');

client.sendKey(13);
assert.equal(sentCommands.pop(), '(KEY 13)\r\n');
console.log('✓ All Christie Serial API command formatters passed');

// 4. Test HomeKit Name Sanitization & Explicit Naming Filter
assert.equal(sanitizeHomeKitName('Christie Projector (Theater)'), 'Christie Projector Theater');
assert.equal(sanitizeHomeKitName('Scope 2.39:1 + HDR'), 'Scope 2 39 1 and HDR');
assert.equal(isExplicitlyNamed('HDMI 1 - Kaleidescape'), true);
assert.equal(isExplicitlyNamed(''), false);
assert.equal(isExplicitlyNamed('Input 1'), false);
assert.equal(isExplicitlyNamed('Channel 2'), false);
console.log('✓ HomeKit name sanitization & explicit naming filter passed');

// 5. Verify config.schema.json allows saving with IP address and optional arrays
const deviceProps = schema.schema.properties.devices.items.properties;
assert.deepEqual(
  schema.schema.properties.devices.items.required,
  ['host'],
  'devices items must require host so unconfigured cards cannot be saved in Homebridge UI',
);
assert.equal(
  deviceProps.host.required,
  true,
  'host property must be marked required: true',
);
assert.equal(
  deviceProps.host.format,
  undefined,
  'host must not use format:"hostname" which rejects IPv4 addresses in Homebridge UI',
);
assert.equal(
  deviceProps.inputs.items.required,
  undefined,
  'inputs items must not be strictly required when empty',
);
assert.equal(
  deviceProps.channels.items.required,
  undefined,
  'channels items must not be strictly required when empty',
);
assert.equal(
  deviceProps.lensPresets.items.required,
  undefined,
  'lensPresets items must not be strictly required when empty',
);
assert.equal(
  deviceProps.testPatterns.items.required,
  undefined,
  'testPatterns items must not be strictly required when empty',
);
console.log('✓ config.schema.json validation rules passed');

// 6. Test Heartbeat State Machine (starts only on ON command, single log per state transition)
const infoLogs = [];
const warnLogs = [];
const hbClient = new ChristieClient(
  {
    host: '172.16.1.247',
    port: 3002,
    pollInterval: 10,
    cooldownGraceSeconds: 5,
  },
  {
    info: (m) => infoLogs.push(m),
    warn: (m) => warnLogs.push(m),
    error: () => {},
    debug: () => {},
  },
);
hbClient.start();
assert.equal(hbClient['heartbeatActive'], false, 'Heartbeat must not start before ON command');
assert.equal(infoLogs.length, 0);
assert.equal(warnLogs.length, 0);

hbClient['heartbeatActive'] = true;
hbClient['expectedPowerState'] = 'on';
hbClient['heartbeatLogState'] = 'awaiting-success';
hbClient.handleIncomingData('(PWR!001 "On")\r\n(PWR!001 "On")\r\n');
assert.equal(infoLogs.length, 1, 'Should write only one log entry for successful heartbeat in ON state');

hbClient['recordHeartbeatFailure']();
hbClient['recordHeartbeatFailure']();
assert.equal(warnLogs.length, 1, 'Should write only one log entry for failed heartbeat in ON state');

hbClient['expectedPowerState'] = 'off';
hbClient['heartbeatLogState'] = 'awaiting-expected-failure';
hbClient['recordHeartbeatFailure']();
hbClient['recordHeartbeatFailure']();
assert.equal(infoLogs.length, 2, 'Should write only one log entry for failed heartbeat in expected OFF state');
hbClient.stop();
console.log('✓ Heartbeat state machine tests passed');

// 7. Test Device Discovery handles unconfigured UI placeholders cleanly without false warnings
const testWarnings = [];
const testDebugs = [];
const publishedAccessories = [];
const mockPlatformLog = {
  info: () => {},
  warn: (msg) => testWarnings.push(msg),
  error: () => {},
  debug: (msg) => testDebugs.push(msg),
};

class MockCharacteristic {
  onGet() { return this; }
  onSet() { return this; }
  updateValue() { return this; }
  setProps() { return this; }
}

class MockService {
  constructor() {
    this.char = new MockCharacteristic();
  }
  setCharacteristic() { return this; }
  getCharacteristic() { return this.char; }
  setPrimaryService() { return this; }
  addLinkedService() { return this; }
  removeLinkedService() { return this; }
  addOptionalCharacteristic() { return this; }
}

const mockTelevisionSpeakerService = class extends MockService {};

const mockApi = {
  hap: {
    Service: {
      AccessoryInformation: class extends MockService {},
      Television: class extends MockService {},
      TelevisionSpeaker: mockTelevisionSpeakerService,
      InputSource: class extends MockService {},
      Switch: class extends MockService {},
      Lightbulb: class extends MockService {},
      Fan: class extends MockService {},
    },
    Characteristic: {
      Name: 'Name',
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      FirmwareRevision: 'FirmwareRevision',
      Active: { ACTIVE: 1, INACTIVE: 0 },
      ActiveIdentifier: 'ActiveIdentifier',
      ConfiguredName: 'ConfiguredName',
      SleepDiscoveryMode: { ALWAYS_DISCOVERABLE: 1 },
      ClosedCaptions: 'ClosedCaptions',
      TargetMediaState: 'TargetMediaState',
      PictureMode: 'PictureMode',
      PowerModeSelection: 'PowerModeSelection',
      RemoteKey: 'RemoteKey',
      IsConfigured: { CONFIGURABLE: 1 },
      CurrentVisibilityState: { SHOWN: 1 },
      Identifier: 'Identifier',
      InputSourceType: { HDMI: 3 },
      On: 'On',
      Brightness: 'Brightness',
      RotationSpeed: 'RotationSpeed',
    },
    uuid: {
      generate: (seed) => `uuid-${seed}`,
    },
    Categories: {
      TELEVISION: 18,
    },
  },
  platformAccessory: class {
    constructor(displayName, uuid, category) {
      this.displayName = displayName;
      this.UUID = uuid;
      this.category = category;
      this.services = [];
    }
    getService(serviceType) {
      if (serviceType === mockTelevisionSpeakerService) {
        return null;
      }
      return new MockService();
    }
    getServiceById() { return null; }
    addService() { return new MockService(); }
    removeService() { return this; }
  },
  on: () => {},
  publishExternalAccessories: (pluginName, accs) => publishedAccessories.push(...accs),
  unregisterPlatformAccessories: () => {},
};

const testPlatform = new ChristieProjectorPlatform(
  mockPlatformLog,
  {
    platform: 'ChristieProjector',
    devices: [
      { name: 'Christie Projector' }, // Unconfigured placeholder created by UI
      { name: 'Christie Projector', host: '172.16.1.247', port: 3002 }, // Valid device
    ],
  },
  mockApi,
);

testPlatform.discoverDevices();
assert.equal(publishedAccessories.length, 1, 'Only the configured projector should be published');
assert.equal(testWarnings.length, 0, 'No warning should be logged for default unconfigured UI placeholders');
assert(
  testDebugs.some((d) => d.includes('Ignoring unconfigured Christie device placeholder')),
  'Unconfigured placeholder should be logged at debug level',
);

// Clean up client sockets
for (const c of testPlatform['clients'].values()) {
  c.stop();
}
console.log('✓ Device discovery placeholder filtering passed');

// 8. Test 4-Octet IPv4 Validation & Schema Pattern
assert.strictEqual(validateChristieHost('172.16.66').valid, false, '172.16.66 has 3 octets and must be rejected');
assert.strictEqual(validateChristieHost('10.0.0').valid, false, '10.0.0 has 3 octets and must be rejected');
assert.strictEqual(validateChristieHost('172.16.1.1.1').valid, false, '5-octet IP must be rejected');
assert.strictEqual(validateChristieHost('256.1.1.1').valid, false, 'out-of-range octet must be rejected');
assert.strictEqual(validateChristieHost('172.16.1.247').valid, true, '172.16.1.247 has 4 valid octets and must be accepted');
assert.strictEqual(validateChristieHost('christie.local').valid, true, 'valid hostname must be accepted');

// Verify pattern in config.schema.json
const christieHostPattern = new RegExp(schema.schema.properties.devices.items.properties.host.pattern);
assert.strictEqual(christieHostPattern.test('172.16.66'), false, 'Schema pattern must reject 3-octet IPv4 172.16.66');
assert.strictEqual(christieHostPattern.test('10.0.0'), false, 'Schema pattern must reject 3-octet IPv4 10.0.0');
assert.strictEqual(christieHostPattern.test('256.1.1.1'), false, 'Schema pattern must reject out of range IPv4');
assert.strictEqual(christieHostPattern.test('172.16.1.247'), true, 'Schema pattern must accept 4-octet IPv4 172.16.1.247');
assert.strictEqual(christieHostPattern.test('christie.local'), true, 'Schema pattern must accept hostname');

// Verify constructor rejects invalid IP
assert.throws(
  () => new ChristieClient({ host: '172.16.66' }, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  /Invalid IPv4 address/,
  'Constructor must reject 3-octet IP',
);

// Verify WoL method
const wolClient = new ChristieClient({ host: '127.0.0.1', mac: '00:1E:06:12:34:56' }, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
assert.strictEqual(typeof wolClient.sendWakeOnLan, 'function');
await wolClient.sendWakeOnLan('00:1E:06:12:34:56');
wolClient.stop();
console.log('✓ IPv4 4-octet validation & WoL tests passed');

console.log('\n🎉 All Christie Projector plugin tests passed!');
