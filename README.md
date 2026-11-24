# homebridge-christie-projector

[![Homebridge](https://img.shields.io/badge/homebridge-plugin-blueviolet?style=flat-square)](https://homebridge.io)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](https://opensource.org/licenses/Apache-2.0)

A [Homebridge](https://homebridge.io) dynamic platform plugin for **Christie Digital Projectors** (Griffyn, Eclipse, M Series, J Series, HS Series, Crimson, Boxer, Cinema CP Series, Matrix, Mirage, and Inspire Series) controlled over Ethernet TCP/IP (default port `3002`) using the **Christie ASCII Serial API**.

---

## Features

- **Unified Apple HomeKit Projector (`TELEVISION` Accessory):**
  - **Power Control (`PWR`):** Turns the projector ON `(PWR 1)` and OFF `(PWR 0)`, and polls `(PWR?)` every `pollInterval` seconds (default `10`s).
  - **Smart Power & Cooldown Detection:** Supports standard Christie power status codes (`(PWR!001)` / `(PWR!1)` = On, `(PWR!000)` / `(PWR!0)` = Standby, `(PWR!11)` = Warming Up, `(PWR!10)` = On / Cooling Down with configurable cooldown grace protection so the switch never snaps back while fans spin down).
  - **Input Source Picker (`SIN` / `SIN+MAIN` / `CHA`):** Switch between explicitly named inputs or channel presets directly from the Apple Home Television accessory card.
  - **iOS Control Center Remote Widget (`KEY` / `OSD` / `FRZ`):** Navigate the Christie projector's on-screen menu using the iPhone/iPad Control Center Remote D-Pad (`ARROW_UP`, `ARROW_DOWN`, `ARROW_LEFT`, `ARROW_RIGHT`, `SELECT`, `BACK/EXIT`, `INFO` -> OSD toggle, `PLAY/PAUSE` -> Image Freeze toggle).
- **Comprehensive Christie Command Switches & Sliders:**
  - **Shutter / Picture Mute Switch (`SHU`):** Close `(SHU 1)` or Open `(SHU 0)` the optical shutter / picture mute.
  - **Image Freeze Switch (`FRZ`):** Freeze `(FRZ 1)` or unfreeze `(FRZ 0)` the image.
  - **On-Screen Display Switch (`OSD`):** Show `(OSD 1)` or hide `(OSD 0)` the on-screen menu.
  - **Picture-in-Picture Switch (`PIP`):** Enable `(PIP 1)` or disable `(PIP 0)` PIP.
  - **Auto Setup Button (`ASU`):** Momentary switch to trigger `(ASU 1)`.
  - **Lens Calibrate / Home Button (`LCB`):** Momentary switch to calibrate motorized lens motors `(LCB 1)`.
  - **Laser / Lamp Output Power Slider (`LPW`):** 0–100% Lightbulb or Fan slider to control `(LPW <0..100>)`.
  - **Channel Preset Switches (`CHA`):** One-tap switches for Christie channel setups `(CHA <id>)`.
  - **Intelligent Lens Memory & Aspect Ratio Switches (`ILF` / `LML` / `SZE`):** One-tap switches for saved lens files `(ILF <id>)` or aspect ratio modes `(SZE <id>)`.
  - **Internal Test Pattern Switches (`ITP`):** Toggle switches to display any built-in test pattern `(ITP <id>)` and return to live video `(ITP 0)` when turned off.
  - **Custom Christie Command Switches:** Define custom switches for any Christie ASCII command (e.g., `(GAM 2.4)`, `(WRP 1)`, `(EDG 1)`, `(LPM 1)`).

---

## Installation

### Option 1: Install via Homebridge Config UI X (Recommended)

Search for **`homebridge-christie-projector`** in the Homebridge UI Plugins tab and click **Install**, or install via CLI:

```bash
hb-service add homebridge-christie-projector
# or
npm install -g homebridge-christie-projector
```

### Option 2: Install Directly from GitHub (No Local Build Required)

Because `dist/` is pre-compiled and committed in the repository and `package.json` avoids `prepare`/`postinstall` build hooks, `npm` installs directly from GitHub without requiring TypeScript or `devDependencies` on the target Homebridge host:

```bash
npm install -g https://github.com/jeremylatrasse/homebridge-christie-projector
```

---

## Pairing with Apple Home & Child Bridge

Running this plugin as a **Child Bridge** (in Homebridge UI → Plugins → `homebridge-christie-projector` → **Bridge Settings**) is supported and recommended so projector restarts or network hiccups stay isolated from other Homebridge accessories.

Because Apple HomeKit treats `TELEVISION` accessories as external accessories (unbridged):

1. Save your configuration and start/restart Homebridge (or the plugin's Child Bridge).
2. Open the **Apple Home** app on your iOS device.
3. Tap **`+`** in the top right corner and choose **Add Accessory**.
4. Tap **More Options...** (or *Don't Have a Code or Can't Scan?*).
5. Select your **Christie Projector** under *Nearby Accessories*.
6. Enter the 8-digit pairing PIN shown in Homebridge UI (either your Child Bridge's PIN if running in Child Bridge mode, or your main Homebridge PIN).

---

## Example `config.json`

Configure using the Homebridge Config UI X form or add the platform to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "ChristieProjector",
      "name": "Christie Projector",
      "_bridge": {
        "username": "0E:79:60:F2:1D:7A",
        "port": 30228,
        "name": "ChristieChildBridge"
      },
      "devices": [
        {
          "name": "Christie Projector",
          "host": "172.16.1.247",
          "port": 3002,
          "pollInterval": 10,
          "cooldownGraceSeconds": 60,
          "treatCode10AsOn": true,
          "enableShutterSwitch": true,
          "enablePowerSwitch": false,
          "enableFreezeSwitch": false,
          "enableOsdSwitch": false,
          "enablePipSwitch": false,
          "enableAutoSetupSwitch": false,
          "enableLensCalibrateSwitch": false,
          "enableLightPowerSlider": false,
          "lightSliderType": "lightbulb",
          "inputs": [
            { "id": 1, "name": "HDMI 1", "type": "HDMI" },
            { "id": 2, "name": "HDMI 2", "type": "HDMI" }
          ],
          "lensPresets": [
            { "id": 1, "name": "Flat 1.85", "commandType": "ILF" },
            { "id": 2, "name": "Scope 2.39", "commandType": "ILF" }
          ],
          "testPatterns": [
            { "id": 1, "name": "Grid Pattern" }
          ]
        }
      ]
    }
  ]
}
```

### Configuration Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `name` | string | `Christie Projector` | Display name for the projector in Apple Home. |
| `host` | string | **Required** | 4-octet IPv4 address or hostname of the Christie projector. |
| `port` | integer | `3002` | Christie Serial-over-Ethernet TCP port (`1`–`65535`). |
| `pollInterval` | integer | `10` | Polling interval in seconds (`2`–`300`) for `(PWR?)`, `(SHU?)`, `(SIN?)`, and `(FRZ?)`. |
| `cooldownGraceSeconds` | integer | `60` | Grace window in seconds (`5`–`300`) preventing HomeKit state snap-back during warmup or cooldown. |
| `treatCode10AsOn` | boolean | `true` | Treats `(PWR!10)` as Power ON outside an active power-off cooldown window. |
| `mac` | string | Optional | Projector MAC address to send a Wake-on-LAN magic packet when powering on. |
| `inputCommandType` | string | `SIN` | Default input selection command (`SIN`, `SIN+MAIN`, or `CHA`). |
| `enableShutterSwitch` | boolean | `true` | Exposes a Switch tile for optical shutter / picture mute `(SHU 1)` / `(SHU 0)`. |
| `enablePowerSwitch` | boolean | `false` | Exposes an additional dedicated Switch tile for `(PWR 1)` / `(PWR 0)`. |
| `enableFreezeSwitch` | boolean | `false` | Exposes an Image Freeze Switch tile `(FRZ 1)` / `(FRZ 0)`. |
| `enableOsdSwitch` | boolean | `false` | Exposes an On-Screen Display Switch tile `(OSD 1)` / `(OSD 0)`. |
| `enablePipSwitch` | boolean | `false` | Exposes a Picture-in-Picture Switch tile `(PIP 1)` / `(PIP 0)`. |
| `enableAutoSetupSwitch` | boolean | `false` | Exposes a momentary Auto Image Setup button `(ASU 1)`. |
| `enableLensCalibrateSwitch` | boolean | `false` | Exposes a momentary Lens Calibrate / Home button `(LCB 1)`. |
| `enableLightPowerSlider` | boolean | `false` | Exposes a 0–100% laser/lamp output power slider `(LPW <0..100>)`. |
| `lightSliderType` | string | `lightbulb` | Service type for the laser/lamp power slider (`lightbulb`, `fan`, or `none`). |
| `inputs` | array | Optional | Named input sources `{ "id": 1, "name": "HDMI 1", "type": "HDMI", "commandType": "SIN" }` shown in the Apple Home Input Picker. |
| `channels` | array | Optional | One-tap Channel Preset switches `{ "id": 101, "name": "Cinema 2.39" }` recalling `(CHA <id>)`. |
| `lensPresets` | array | Optional | One-tap Lens Memory / Aspect Ratio switches `{ "id": 1, "name": "Scope 2.40", "commandType": "ILF" }` (`ILF`, `LML`, or `SZE`). |
| `testPatterns` | array | Optional | Toggle switches `{ "id": 1, "name": "Grid Pattern" }` for internal test patterns `(ITP <id>)` / `(ITP 0)`. |
| `customCommands` | array | Optional | Custom switches `{ "name": "GAMMA 2.4", "onCommand": "(GAM 2.4)", "offCommand": "(GAM 2.2)", "momentary": false }`. |

---

## Christie Serial API Command Reference

All commands implemented in [`ChristieClient`](./src/christieClient.ts) use the Christie ASCII framing over TCP port `3002`:

| Category | Function | Set Command | Query Command | Example Reply |
| :--- | :--- | :--- | :--- | :--- |
| **Power** | Power On / Off | `(PWR 1)` / `(PWR 0)` | `(PWR?)` | `(PWR!001)` / `(PWR!10)` / `(PWR!000)` |
| **Power** | Standby Comms Mode | `(PWR+STBM 1)` / `(PWR+STBM 0)` | `(PWR+STBM?)` | `(PWR+STBM!001)` |
| **Power** | Standby Electronics | `(PWR+ELEC 1)` / `(PWR+ELEC 0)` | `(PWR+ELEC?)` | `(PWR+ELEC!001)` |
| **Shutter** | Shutter Close / Open | `(SHU 1)` / `(SHU 0)` | `(SHU?)` | `(SHU!001)` / `(SHU!000)` |
| **Input** | Select Input | `(SIN <id>)` | `(SIN?)` | `(SIN!001)` |
| **Input** | Main / PIP Input | `(SIN+MAIN <id>)` / `(SIN+PIP <id>)` | `(SIN+MAIN?)` | `(SIN+MAIN!001)` |
| **Channel** | Select Channel Setup | `(CHA <id>)` | `(CHA?)` | `(CHA!101)` |
| **Freeze** | Image Freeze | `(FRZ 1)` / `(FRZ 0)` | `(FRZ?)` | `(FRZ!000)` |
| **OSD** | On-Screen Display | `(OSD 1)` / `(OSD 0)` | `(OSD?)` | `(OSD!001)` |
| **PIP** | Picture-in-Picture | `(PIP 1)` / `(PIP 0)` | `(PIP?)` | `(PIP!000)` |
| **PIP** | Swap Main & PIP | `(PPS 1)` | — | — |
| **Pattern** | Internal Test Pattern | `(ITP <id>)` / `(ITP 0)` | `(ITP?)` | `(ITP!000)` |
| **Lens** | Intelligent Lens Memory | `(ILM 1)` / `(ILM 0)` | `(ILM?)` | `(ILM!001)` |
| **Lens** | Recall / Save Lens File | `(ILF <slot>)` / `(LMS <slot>)` | `(ILF?)` | `(ILF!001)` |
| **Lens** | Lens Calibrate (Home) | `(LCB 1)` | — | — |
| **Lens** | Zoom / Focus | `(ZOM <val>)` / `(FCS <val>)` | `(ZOM?)` / `(FCS?)` | `(ZOM!100)` |
| **Lens** | H / V Lens Shift | `(LHO <val>)` / `(LVO <val>)` | `(LHO?)` / `(LVO?)` | `(LHO!050)` |
| **Image** | Brightness / Contrast | `(BRT <val>)` / `(CON <val>)` | `(BRT?)` / `(CON?)` | `(BRT!050)` |
| **Image** | Color / Sharpness | `(CLR <val>)` / `(SHP <val>)` | `(CLR?)` / `(SHP?)` | `(CLR!050)` |
| **Image** | Gamma / Size (Aspect) | `(GAM <val>)` / `(SZE <mode>)` | `(GAM?)` / `(SZE?)` | `(SZE!001)` |
| **Image** | Auto Image Setup | `(ASU 1)` | — | — |
| **Geometry** | Keystone / Warp / Edge | `(KST <v>)` / `(WRP <s>)` / `(EDG <s>)` | `(KST?)` / `(WRP?)` | `(WRP!001)` |
| **Light** | Laser / Lamp Power | `(LPW <0..100>)` | `(LPW?)` | `(LPW!085)` |
| **Light** | Lamp / Laser Hours | — | `(LPH?)` | `(LPH!01250)` |
| **Keypad** | Remote Key Emulation | `(KEY <code>)` | — | — |
| **System** | Status / Info / Errors | — | `(SST?)` / `(PIF?)` / `(ERR?)` | — |

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript to dist/ and install git hooks
make build

# Run unit, schema slider audit, and mock-server tests
make test
```

See [MAINTAINING.md](./MAINTAINING.md) for architecture details, Config UI X schema rules, git hooks, and the OIDC npm release pipeline.

## License

Apache-2.0 © Jeremy LaTrasse
