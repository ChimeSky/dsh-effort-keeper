# EffortKeeper · per-model reasoning-effort memory

[中文](README.md) | English

EffortKeeper is a standalone **Host plugin** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that fixes one concrete annoyance:

> Pick **High** for Claude Sonnet 5.5, switch to Gemini, switch back — DSH shows **Default** again.

The plugin remembers the last effort you explicitly chose for each **provider ID + model ID** pair, and restores it with the **same native selection call** when you switch back. You keep using DSH's own model picker and effort menu — no extra page, no save button.

- Package: `dsh-effort-keeper`
- Version: `1.0.5`
- Verified runtime: DSH Desktop `0.2.1-rc.3` (Windows)
- Dependencies: none (Node standard library and services DSH already provides)

---

## 1. What it does

| Requirement | Implementation |
|---|---|
| Independent per-model memory | Key is `provider::model`; display names never affect identity |
| Restore on model switch | Decorates Host `sessionController.selectModel` and rewrites the target effort inside the same call |
| Save manual changes | An effort change on the same model is persisted after the native call succeeds |
| Persistence | Uses the official `ctx.storageDomain` at `$DSH_HOME/storages/effort_keeper.json` |
| Default semantics | An explicit Default is stored as `null`; restoring removes `reasoningEffort` instead of re-applying a stale effort |
| Capability changes | Checks `reasoning.efforts` through `ctx.llm.resolveModelInfo` before restoring; unsupported efforts are not sent |
| New sessions | A blank session restores the current model's preference; existing conversations are never retroactively modified |
| Disable / uninstall | Restores the original method; no DSH core files are modified |

It stores no API keys, chat content, tool arguments, or session bodies.

---

## 2. Why a Host-only plugin

DSH's model catalogue lives on the client side (`@deepseek-ai/dsh-client-ui-model-selection`), but every choice is submitted through a public Host method:

```text
Client model menu → session.selectModel (Remote)
                  → ctx.sessionController.selectModel(request)
                  → resolveCallConfig + session.append('model/selection')
```

So EffortKeeper ships no second picker and touches no DOM. It decorates the **single entry point** `ctx.sessionController.selectModel`:

1. The user clicks a model or an effort; the native call is sent as usual.
2. The decorator reads the session's `modelSelection` projection.
3. If this is a model switch and the target model has a saved effort, it replaces `reasoningEffort` in the same request object before running the native implementation.
4. The native implementation runs exactly once — the UI never shows a wrong effort and is not corrected by a second call.
5. If this is an effort change on the same model, it lets the native call succeed first, then persists the user's choice.

On unload the original method is restored untouched. DSH sources, core packages under `node_modules`, and the native picker are not modified.

### About the global default model

DSH's native `selectModel` also writes the current choice into the `agent-default-model` profile config. That is existing DSH behaviour, not EffortKeeper's memory. EffortKeeper's memory always lives in its own per-model store:

- it never applies one effort to every model;
- it never simulates "memory" by rewriting the global default repeatedly;
- restoring an effort and choosing one by hand both trigger DSH's native last-used default update.

This is the boundary of the current DSH API and is listed under known limitations.

---

## 3. Storage

DSH's storage domain writes `$DSH_HOME/storages/effort_keeper.json`:

```json
{
  "unit": { "name": "effort_keeper", "version": 1 },
  "global": {
    "version": 1,
    "preferences": {
      "openrouter-custom::anthropic/claude-sonnet-5.5": "high",
      "openrouter-custom::anthropic/claude-opus-5.5": "max",
      "openrouter-custom::google/gemini-4-argon": "medium",
      "openrouter-custom::anthropic/claude-sonnet-5.5-old": null
    }
  },
  "tables": {}
}
```

- a string: an explicit effort ID;
- `null`: the user explicitly chose Default;
- a missing key: no preference yet, so DSH's native behaviour is kept.

The file is a separate domain file. It does not overwrite providers, model definitions, `package.json`, or other plugins' configuration. Writes are serialized and atomically flushed by the storage domain.

---

## 4. Install

### 4.1 Prerequisites

1. Quit DSH Desktop completely (including the tray icon).
2. DSH version within `>=0.2.1-rc.3 <0.3.0-0`.
3. Either use the bundled `vendor/dsh-effort-keeper-1.0.5.tgz`, or build it first:

```powershell
pnpm pack --pack-destination vendor
```

### 4.2 Install with the DSH CLI

```powershell
# Windows default install location; adjust to your own DSH install
$dsh = '<DSH install>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add `
  '<repo>\vendor\dsh-effort-keeper-1.0.5.tgz'
```

The CLI adds the package to the profile dependencies and `dsh.profile.bundles`, and lets DSH's own pnpm install it. `tools/install.ps1` wraps the same steps:

```powershell
pwsh -File .\tools\install.ps1
```

### 4.3 Install from the plugin manager

In DSH's **Plugins** page choose **Add plugin → Install third-party plugin** and point it at this directory or at the tarball. After install, `dsh-effort-keeper` appears in the plugin list.

### 4.4 Start and verify

Reopen DSH. Verify the diagnostic endpoint:

```js
// Needs the DSH page's same-origin cookie; run in the page DevTools console:
fetch('/effort-keeper/status').then(r => r.json()).then(console.log)
```

Expected:

```json
{
  "ok": true,
  "version": 1,
  "persistence": "storage-domain",
  "preferences": { "version": 1, "preferences": {} },
  "stats": { "restores": 0, "saves": 0, "unsupported": 0, "failures": 0 },
  "restoredSessions": 1
}
```

The endpoint returns model routing keys and effort IDs only — never credentials, prompts, or chat content.

### 4.5 Check the installed copy by hand

```powershell
pwsh -File .\tools\verify-install.ps1
# or
node .\tools\verify-install.mjs --profile desktop
```

It checks:

- profile dependencies and bundle list;
- installed `package.json` name/version;
- that installed `index.js` and `lib/*.js` are byte-identical to the workspace sources;
- the `effort-keeper` row in the bundle patch.

---

## 5. Usage

No new gestures:

1. Choose Sonnet 5.5 and set reasoning effort to High;
2. Switch to Gemini 4 Argon and set effort to Medium;
3. Switch back to Sonnet 5.5;
4. The native picker shows High again, and the next request header carries `reasoningEffort: "high"`.

Switching to a model that was never configured keeps DSH's native default — nothing is restored by mistake.

New sessions pick up the current model's saved preference; conversations that already started are left alone.

---

## 6. Disable and uninstall

### Disable

- Turn `EffortKeeper` off in DSH's **Plugins** page; or
- add this to the profile's `cordis.patch.yml`:

```yaml
- id: effort-keeper
  disabled: true
```

The decorator is restored when the Cordis fiber unloads, and DSH returns to native selection behaviour.

### Uninstall

```powershell
$dsh = '<DSH install>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop remove dsh-effort-keeper
```

Then confirm `dsh-effort-keeper` is gone from the profile's `dsh.profile.bundles` (recent CLIs clean it up; otherwise delete it by hand) and restart DSH.

The preference file `$DSH_HOME/storages/effort_keeper.json` can stay: a reinstall keeps using it. If you do not want it, delete the file after confirming no other plugin uses that domain.

Or:

```powershell
pwsh -File .\tools\install.ps1 -Uninstall
```

---

## 7. Project layout

```text
effort-keeper/
├── index.js                 Host entry, optional status route
├── lib/
│   ├── core.js              Pure state/selection rules (unit-tested)
│   └── bridge.js            Storage domain, selectModel decorator, new-session restore
├── cordis.patch.yml         Bundle insertion row
├── locale/{zh,en}.json      Plugin display metadata
├── icon.svg                 Original icon
├── tests/
│   ├── core.test.mjs        13 pure-logic tests
│   └── bridge.test.mjs      8 bridge/lifecycle tests
├── tools/
│   ├── build-vendor.mjs     Pack helper
│   ├── install.ps1          Install / uninstall / verify
│   └── verify-install.mjs   Installed-copy verification
├── vendor/                  Frozen tarball
├── LICENSE                  MIT
├── README.md                Chinese README
└── TEST_REPORT.md           Real test log and known limitations
```

---

## 8. Configuration

The MVP has no settings page: behaviour is folded into the native picker. Enable/disable through the DSH plugin manager or a profile patch.

To turn memory off, just disable the plugin; nothing else is affected.

---

## 9. Known limitations

1. **DSH still updates the global default.** `sessionController.selectModel` is designed to "save the session choice + save the default in the background". EffortKeeper does not treat the global default as storage, but a restore updates it exactly like a manual choice. That is the public API semantics of DSH `0.2.1-rc.3`.
2. **Host method decoration.** The plugin wraps a public service method instead of patching source. If a future DSH version changes the signature or existence of `sessionController.selectModel`, the plugin fails loudly rather than silently corrupting a session. Re-run the tests before a major upgrade.
3. **Existing sessions are not retroactive.** On install or restart, preferences are applied only to blank sessions with no committed turn; conversations already underway keep their historical choice.
4. **Undeclared efforts are not sent.** A saved effort the model no longer advertises is ignored with a non-intrusive debug log; the preference is kept for when the capability returns.
5. **No arbitrary per-model effort names.** Only the `reasoning.efforts` an adapter advertises are used.
6. **Status route.** `/effort-keeper/status` is a read-only diagnostic endpoint that exposes only model routing keys and effort IDs. Like other local DSH page routes, it is registered only when a web host exists.

---

## 10. Development

```powershell
node --test tests/*.test.mjs
node --check index.js
node --check lib/core.js
node --check lib/bridge.js
```

After changing sources, raise `version` in `package.json` (version discipline), then repack:

```powershell
pnpm pack --pack-destination vendor
```

DSH profiles pin the tarball integrity through the pnpm lockfile, so the same name and version with different content is not re-read.

---

## 11. License

MIT. `icon.svg` was drawn for this project.
