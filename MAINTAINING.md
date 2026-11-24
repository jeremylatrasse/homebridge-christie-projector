# Building & Maintaining `homebridge-christie-projector`

This guide documents everything required to build, extend, test, version, and release `homebridge-christie-projector` across Node.js, Homebridge Config UI X, Xcode, GitHub, and npm.

---

## 1. Architecture & File Map

| Path | Role |
| :--- | :--- |
| [src/index.ts](src/index.ts) | Homebridge CommonJS entry point (`export = init`). |
| [src/settings.ts](src/settings.ts) | Defines `PLUGIN_NAME` (`homebridge-christie-projector`), `PLATFORM_NAME` (`ChristieProjector`), `CHRISTIE_DEFAULT_PORT` (`3002`), and `PLUGIN_VERSION` / `loadPluginVersion()`. |
| [src/platform.ts](src/platform.ts) | `ChristieProjectorPlatform` (`DynamicPlatformPlugin`), config normalization (`normalizePlatformConfig`), scoped platform name resolution, legacy cached bridged-accessory cleanup, and external `TELEVISION` accessory publication. |
| [src/platformAccessory.ts](src/platformAccessory.ts) | `ChristieProjectorAccessory`: HomeKit `Service.Television` (`TELEVISION`), explicitly named `Service.InputSource` inputs/channels, optional Power / Shutter / Freeze / OSD / PIP / Auto Setup / Lens Calibrate / Channel / Lens Preset / Test Pattern / Custom Command switches, Laser/Lamp Power slider (`Service.Lightbulb` or `Service.Fan`), `sanitizeHomeKitName`, and `isExplicitlyNamed`. |
| [src/christieClient.ts](src/christieClient.ts) | `ChristieClient`: single persistent TCP socket on port `3002`, Christie parenthesized ASCII Serial API parser/formatter, cooldown/warmup grace state machine, unified heartbeat logging, Wake-on-LAN UDP magic packet broadcast, and strict 4-octet IPv4 / hostname validation (`validateChristieHost`). |
| [config.schema.json](config.schema.json) | Homebridge Config UI X schema (`pluginAlias` must equal `PLATFORM_NAME`). |
| [test-christie.mjs](test-christie.mjs) | Node unit, protocol, schema slider audit, config normalization, and mock-server test suite executed against compiled `dist/` via `npm test`. |
| [dist/](dist/) | **Tracked in git** compiled output for zero-compile GitHub installations. |

---

## 2. Core Design Rules (Do Not Break)

### A. Zero-Compile GitHub Installs
Homebridge users often install directly from GitHub (`npm install git+https://github.com/jeremylatrasse/homebridge-christie-projector.git`) on systems without `typescript` or `devDependencies`.
1. **Always commit updated `dist/` files** whenever `src/` changes. (`.gitignore` intentionally keeps `dist/` tracked.)
2. **Keep `"dependencies": {}` empty** in `package.json`. Use Node.js built-ins (`node:net`, `node:dgram`, `node:events`, `node:fs`, `node:path`) and put `@types/node`, `homebridge`, and `typescript` in `devDependencies`.
3. **Never add `"prepare"` or `"postinstall"` scripts** in `package.json`—they run during `npm install` on target Homebridge hosts and can fail in restricted environments. Use `"prepublishOnly"` instead.
4. **Keep CommonJS entry export** (`export = init`) in `src/index.ts`, and resolve scoped platform names safely in `src/platform.ts`:
   ```ts
   this.registeredPlatformName = this.config.platform
     ? String(this.config.platform).split('.').pop() || PLATFORM_NAME
     : PLATFORM_NAME;
   ```

### B. Child Bridge, Single-Socket & Hardware Resilience
* Never throw uncaught exceptions during startup or `didFinishLaunching` if a projector is offline, in standby, or has an invalid host (`validateChristieHost()` logs a clear error and skips invalid hosts in `discoverDevices()`).
* **Single-Socket Discipline:** Keep normal heartbeat/status polling on the single persistent TCP socket (`this.socket`) rather than opening extra throwaway TCP connections to port `3002` during periodic polling—projector Ethernet servers often cap concurrent TCP sessions and can stall other control systems if sockets are repeatedly opened and dropped.
* On Homebridge `shutdown`, stop all `ChristieClient` instances (clearing timers and cleanly ending open TCP sockets with a short `unref()` fallback destroy timer).
* Preserve the quiet heartbeat logging state machine: heartbeat probing starts on `powerOn()` / `powerOff()`, logging once per state transition instead of flooding Homebridge logs while the projector is off.

---

## 3. Christie ASCII Serial Protocol & State Machine (`src/christieClient.ts`)

`ChristieClient` communicates with Christie Digital projectors over raw TCP (default port `3002`) using parenthesized ASCII frames terminated with `\r\n`:

| Direction | Frame / Command | Meaning & Required Behavior |
| :--- | :--- | :--- |
| **TX (Power)** | `(PWR 1)` / `(PWR 0)` / `(PWR?)` | Power On, Power Off, and Power status query (supports custom `onCommand` / `offCommand` / `stateCommand` overrides). |
| **RX (Power)** | `(PWR!000)` / `(PWR!001)` / `(PWR!11)` / `(PWR!10)` | `0` = Off/Standby, `1` = On, `11` = Warming Up, `10` = On or Cooling Down (protected by `cooldownGraceSeconds` & `treatCode10AsOn`), `20`–`23` = Auto/Emergency Shutdown. |
| **TX / RX (Shutter)** | `(SHU 1)` / `(SHU 0)` / `(SHU?)` $\rightarrow$ `(SHU!001)` | Closes (`1`) or opens (`0`) optical shutter / picture mute. |
| **TX / RX (Inputs)** | `(SIN <id>)`, `(SIN+MAIN <id>)`, `(SIN+PIP <id>)`, `(CHA <id>)` | Switches active input or channel setup and parses `(SIN!...)` / `(CHA!...)` replies. |
| **TX / RX (Controls)** | `(FRZ)`, `(OSD)`, `(PIP)`, `(PPS 1)`, `(ASU 1)`, `(LCB 1)` | Freeze, OSD, PIP, PIP Swap, Auto Setup, Lens Calibrate. |
| **TX / RX (Lens / Light / Pattern)** | `(ILF <id>)`, `(LML <id>)`, `(SZE <id>)`, `(LPW <0..100>)`, `(ITP <id>)`, `(KEY <code>)` | Lens memory, aspect ratio, laser/lamp power, internal test patterns, and keypad emulation. |
| **TX (Wake-on-LAN)** | UDP Broadcast Magic Packet (Port `9`) | Optional `6x 0xFF` + `16x MAC` broadcast when `mac` is configured. |

---

## 4. HomeKit Accessories & UUID Stability (`src/platformAccessory.ts`)

* Each configured Christie projector is published as a **single unified external accessory** (`publishExternalAccessories`, category `TELEVISION`) with:
  * `Service.Television` (primary service): Power (`Active`), Input Picker (`ActiveIdentifier`), and iOS Control Center Remote keys (`RemoteKey`).
  * `Service.InputSource`: Only explicitly named inputs (`isExplicitlyNamed(input.name)`) are added and linked via `tvService.addLinkedService(inputService)`.
  * Optional in-room switches (`Power`, `Shutter`, `Freeze`, `OSD`, `PIP`, `Auto Setup`, `Lens Calibrate`, `Channel`, `Lens Preset`, `Test Pattern`, `Custom Command`) and Laser/Lamp Power slider (`Service.Lightbulb` or `Service.Fan`).
* **Critical iOS Home Rule:** Never call `tvService.addLinkedService()` on `Switch`, `Lightbulb`, or `Fan` services—linking non-`InputSource` services to `Service.Television` causes iOS Home.app to hide their in-room tiles.
* **No `Service.TelevisionSpeaker`:** Avoid exposing a speaker service so the iOS Control Center Apple TV Remote widget does not hijack hardware volume buttons for the projector.
* **UUID Stability:** Keep the external accessory UUID seed unchanged (`christie-projector-${device.host}:${port}`) so existing Apple Home room assignments and scenes never break across upgrades.

---

## 5. `config.schema.json` & Config UI X Rules

Homebridge Config UI X uses `@ng-formworks/core`, which automatically renders any bounded `"integer"` or `"number"` field (with `"minimum"` and `"maximum"`) as a **range slider** (`<input type="range">`) instead of a numeric text box.

* **Mandatory Rule:** Every numeric field (`"type": "integer"` or `"type": "number"`) in `config.schema.json` that defines `"minimum"` AND `"maximum"` **must** include:
  ```json
  "x-schema-form": {
    "type": "number"
  }
  ```
* Never use `"widget": "range"` or `"type": "range"`.
* Never add `"format": "hostname"` to `host` (it causes Config UI X to reject valid 4-octet IPv4 addresses); use the strict 4-octet IPv4 / RFC 1123 hostname `"pattern"` regex instead.
* Never add `"required": ["id", "name"]` inside `inputs.items`, `channels.items`, `lensPresets.items`, or `testPatterns.items` (it breaks saving empty/partial rows in Config UI X).
* Keep `pluginAlias` (`"ChristieProjector"`) identical to `PLATFORM_NAME` in `src/settings.ts`.

### Slider Audit Command
Run this from the project root after any `config.schema.json` edit to verify valid JSON and zero unintended sliders (should print an empty table; also enforced automatically by `npm test`):

```bash
node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync("config.schema.json", "utf8"));
const hits = [];
function walk(node, path) {
  if (!node || typeof node !== "object") return;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const isBounded = Object.hasOwn(node, "minimum") && Object.hasOwn(node, "maximum");
  const isSliderType = types.includes("integer") || types.includes("number");
  const hasOverride = Boolean(
    node["x-schema-form"]?.type ||
    node["x-schema-form"]?.widget?.component ||
    typeof node["x-schema-form"]?.widget === "string" ||
    node.widget?.component ||
    typeof node.widget === "string"
  );
  if (isBounded && isSliderType && !hasOverride && path !== "schema.properties._bridge.properties.port") {
    hits.push({ path, type: node.type, minimum: node.minimum, maximum: node.maximum });
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.properties.${k}`);
  }
  if (node.items) {
    if (Array.isArray(node.items)) node.items.forEach((v, i) => walk(v, `${path}.items[${i}]`));
    else walk(node.items, `${path}.items`);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(node[key])) node[key].forEach((v, i) => walk(v, `${path}.${key}[${i}]`));
  }
}
walk(root.schema, "schema");
console.table(hits);
if (hits.length > 0) process.exit(1);
'
```

---

## 6. Local Development, Testing & Xcode Workflow

### Node / TypeScript Commands
```bash
npm install          # Install devDependencies locally
npm run compile      # Compile src/ -> dist/ via tsc
npm run watch        # Incremental compile during development
npm test             # Compiles TypeScript and runs test-christie.mjs
```

### Checklist When Modifying Features or Config
1. Update TypeScript source in `src/`.
2. If adding or changing config keys:
   * Update `normalizePlatformConfig()` / types in `src/platform.ts`, `src/platformAccessory.ts`, and `src/christieClient.ts`.
   * Update `config.schema.json` (remembering `"x-schema-form": { "type": "number" }` for bounded numbers/integers).
   * Update the Configuration Parameters table in `README.md`.
3. Add or update assertions in `test-christie.mjs`.
4. Run `npm test` (which rebuilds `dist/` and runs all unit, mock-socket, config, and slider audit tests).
5. Verify `git status` includes updated `dist/` files alongside `src/`.

### Xcode Workflow (`⌘B`)
* Opening `homebridge-christie-projector.xcodeproj` runs `make` (`make hooks build`), compiling `src/` $\rightarrow$ `dist/` and installing the local git hooks.

---

## 7. Git Versioning, Hooks & OIDC Release Pipeline

### Local Git Hooks (`.githooks/` & `.git/hooks/`)
This repository uses local hooks (`pre-commit`, `post-commit`, `pre-push`, installed via `make hooks`) to keep versions and `dist/` synchronized across npm and Xcode:
* **`pre-commit`:** Automatically unstages local-only Xcode files, increments the patch version in `package.json`, `package-lock.json`, and `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` inside `homebridge-christie-projector.xcodeproj/project.pbxproj`, recompiles `dist/`, and stages `package.json`, `package-lock.json`, and `dist/`.
* **`post-commit`:** Ensures partial/IDE commits (e.g., Xcode Source Control UI) include the bumped version files and creates/updates the local `vX.Y.Z` tag.
* **`pre-push`:** Verifies that `HEAD` has an incremented version relative to the remote branch before pushing.
* **Bypass bumping when needed** (e.g., amending or keeping an explicit version):
  ```bash
  SKIP_VERSION_BUMP=1 git commit -m "..."
  ```

### GitHub Actions & OIDC Release Pipeline (`.github/workflows/bump-version.yml`)
* On every push to `main` / `master` (except `chore(release):` or `[skip ci]` commits), CI installs dependencies, runs `npm test`, creates/updates the `vX.Y.Z` git tag matching `package.json`, and publishes the new version to npm (skipping publish if that version already exists on npm).
* Publishing uses **npm Trusted Publishing (OIDC)** via `id-token: write` and Node 24 (`npm >= 11.5.1`), automatically attaching **SLSA provenance attestation** on public repos with no long-lived `NPM_TOKEN` required (or falling back to a GitHub `NPM_TOKEN` secret if explicitly configured).
* **One-time npm Trusted Publisher setup** (for a brand-new npm package):
  1. Publish the package manually once (`npm publish --access public`, or a bootstrap `0.0.0-stage`) so npmjs.com exposes **Package Settings → Access → Trusted Publisher**.
  2. Add a **GitHub Actions** Trusted Publisher with owner `jeremylatrasse`, repository `homebridge-christie-projector`, workflow filename `bump-version.yml`, **blank Environment**, and enable **Allow npm publish**.
  3. Every subsequent push to `main` publishes automatically with SLSA provenance attestation (allow ~2–3 minutes for npm's CDN to propagate `latest`).
* **Do not** add a second unconditional `npm version patch` step in CI while local `pre-commit` hooks are active, or every commit will be double-bumped.

### Publishing to npm & `homebridge/verified` Checklist
1. Inspect what will be included in the npm tarball (`package.json` `files` allowlist includes only `dist`, `config.schema.json`, `LICENSE`, `README.md`, and `package.json`):
   ```bash
   npm pack --dry-run
   ```
2. Run `npm test` and confirm clean `git status`.
3. Push to `main` to trigger automated OIDC publishing (after the initial manual publish + Trusted Publisher setup).
4. Before submitting or updating `github.com/homebridge/verified`:
   * Published publicly on npm with `"homebridge-plugin"` in `package.json` `keywords`.
   * Valid `config.schema.json` at root, `pluginAlias` matching `src/settings.ts`, and zero slider fields.
   * Child Bridge safe when the projector is in standby, cooling down, or offline.
   * `README.md` documents npm installation, Child Bridge & Apple Home pairing, and the full Configuration Parameters table.
