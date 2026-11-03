import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChristieClient } from './dist/christieClient.js';
import { sanitizeHomeKitName, isExplicitlyNamed } from './dist/platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './dist/settings.js';

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

console.log('\n🎉 All Christie Projector plugin tests passed!');
