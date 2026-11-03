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

## Example `config.json`

```json
{
  "platforms": [
    {
      "platform": "ChristieProjector",
      "name": "Christie Projector",
      "_bridge": {
        "username": "0E:79:60:F2:1D:7A",
        "port": 30228,
        "name": "PROJ102ChildBridge",
        "debugModeEnabled": true
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

---

## Pairing External Projector Accessory in Apple Home

Because Apple HomeKit treats `TELEVISION` accessories as external accessories:
1. Restart Homebridge after saving your configuration.
2. Open the **Apple Home** app -> tap **`+`** -> **Add Accessory** -> **More Options...**
3. Select **Christie Projector** and enter your Homebridge 8-digit setup PIN.

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript to dist/
make build

# Run unit tests
make test
```

## License

Apache-2.0 © Jeremy LaTrasse
