# 🎒 DSH Config Manager

**Pack up your DSH configuration and take it anywhere — restore your whole environment on a new machine with one click.**

[English](README.md) · [简体中文](README.zh-CN.md)

---

## What is this? 🤔

DSH is your AI assistant workbench — it holds your settings: model configs, plugins, skills, workspaces…

**DSH Config Manager is its "moving service"**:

```
┌──────────────┐   ① one-click    ┌─────────────────┐   ② one-click    ┌──────────────┐
│  Machine A    │ ──── export ───► │ dsh-config.zip   │ ──── import ───► │  Machine B    │
│  my config    │                  │   (one file)     │                  │  all restored │
└──────────────┘                  └─────────────────┘                  └──────────────┘
```

> ⚠️ **Security first**: no secrets (API Key / Token / Password) are exported by default. See [Security](#-security).

---

## ✨ Highlights

| Icon | Feature | In one line |
|:---:|---|---|
| 🚀 | **One-click Export** | Package your recommended config into a ZIP |
| 📦 | **One-click Import** | Restore your environment on another machine |
| 👀 | **Preview before import** | Full preview first — **never touches your config silently** |
| ⚔️ | **Conflict handling** | Keep Current / Use Imported / Review — you decide |
| 🗺️ | **Path auto-mapping** | Detects dead absolute paths and lets you remap them |
| 🔒 | **Secret safety** | API Keys are never exported; re-enter them after import |
| ↩️ | **Automatic rollback** | Failed import restores everything automatically |
| 🗂️ | **Profiles** | Save multiple setups (Work / Personal) and switch anytime |

---

## 🔄 How it works?

### Export (pack it up)

```
Read your config → strip secrets (safe) → build manifest → compute checksums → pack into ZIP
```

### Import (restore the environment)

Every step confirms and backs up first — **it never modifies your config directly**:

```
Select ZIP → validate file → check integrity → check schema → compatibility check
    → scan contents → build import plan → preview & confirm
    → auto-backup current config → apply → validate → done
                      │
                      └─ failed midway? → automatically restored (rollback)
```

---

## 📥 Installation

It's a standard **DSH plugin** — two steps:

```bash
# ① Install the plugin
dsh plugin --profile web add dsh-config-manager@latest --config.auto-install-peers=false

# ② Restart DSH (a "Backup & Migration" entry appears in Settings)
```

> 💡 **Why the flag?** `--config.auto-install-peers=false` skips a few DSH core packages that aren't on the public registry yet (the DSH runtime provides them). Just copy-paste it.
>
> 💡 **Why `@latest`?** A bare `dsh plugin add dsh-config-manager` keeps the version already recorded in the profile (pnpm does not upgrade existing deps). Use `@latest` — or an exact version like `@0.1.3` — to get the newest build.

**From source / local package** (for developers):

```bash
npm run build && npm pack          # produces dsh-config-manager-0.1.2.tgz
dsh plugin --profile web add file:/absolute/path/dsh-config-manager-0.1.2.tgz
```

> 🧪 **Try it without touching your real environment?** Use an isolated `DSH_HOME`:
> ```bash
> $env:DSH_HOME = "D:\tmp\dsh-home"   # Windows PowerShell
> dsh plugin --profile test add dsh-config-manager@latest --config.auto-install-peers=false
> dsh --profile test --dump-config | Select-String config-manager
> ```

---

## 🚀 Quick start (3-minute tour)

```
Machine A (export)
  1. Open DSH → Settings → "Backup & Migration"
  2. Click "Export Configuration" → choose "Quick Export"
  3. You get dsh-config-2026-08-14.zip (the report confirms no secrets inside)

Copy the ZIP to Machine B (import)
  1. Open DSH → "Backup & Migration" → "Import Configuration"
  2. Select the ZIP → wait for analysis → review the "Import Preview"
  3. Path issues? → choose new paths (batch mapping supported)
  4. Conflicts? → choose Keep Current / Use Imported
  5. Confirm import → wait
  6. Re-enter any missing API Keys as prompted
  7. ✅ Settings / plugins / MCP / skills / workspaces are back
```

---

## 🧩 Features

### 📤 Export (two modes)

| Mode | Description |
|---|---|
| **Quick Export** (recommended) | One-click: settings / UI / models / plugins / MCP / skills / workspaces… |
| **Custom Export** | Tick the categories you want |

> Output: `dsh-config-<date>.zip` with manifest + per-category data + SHA-256 checksums.

### 📥 Import (safe flow)

- **Nothing is written before confirmation** — analyze & preview are zero-write
- **Backup before applying** — the target config is snapshotted automatically
- **Automatic rollback on failure** — full rollback or skip-and-continue, your choice

### 👀 Import Preview (dry run)

Shown fully before importing:

```
✓ 18 settings will be updated    ✓ 6 plugins already installed
⚠ 2 plugins need installation    ⚠ 3 secrets need re-entry
⚠ 1 path needs mapping           ⚠ 2 conflicts need attention
```

### ⚔️ Conflict handling

When the target already has a same-named item, you choose:

| Option | Meaning |
|---|---|
| **Keep Current** | Leave the target's config untouched |
| **Use Imported** | Overwrite with the backup's value |
| **Review** | Skip for now, handle later |

### 🗺️ Path mapping

`C:\Users\alice\projects` doesn't exist on the new machine? The plugin:
1. Detects the dead absolute paths automatically
2. Lets you pick new paths
3. Supports **batch prefix mapping** (`C:\Users\alice\` → `/Users/bob/` in one shot)

### 🔒 Secrets

| Scenario | Behavior |
|---|---|
| Default backup | **No secret values at all** — only records which keys are needed |
| Encrypted backup (optional) | AES-256-GCM with a password; the password is **never written to the file** |
| After import | "3 secrets need re-entry" — values stay in memory only |

### 🗂️ Profiles

Save multiple configurations (Work / Personal) and switch anytime; switching includes preview + auto-backup + rollback.

---

## 📦 What's inside a backup?

```
dsh-config-2026-08-14.zip
├── manifest.json              # backup manifest: version / source / time / sections
├── config/
│   ├── settings.json          # settings (redacted)
│   └── ui.json                # UI preferences
├── ai/providers.json          # AI providers / models
├── plugins/                   # plugin manifest (binaries are never packaged)
├── mcp/servers.json           # MCP server configs
├── custom/                    # prompts / skills
├── agents/presets/            # agent presets
├── workspaces/                # workspaces
├── security/credentials.json  # credential state (no values)
├── security/secrets.enc       # encrypted backups only
└── integrity/checksums.json   # SHA-256 checksums
```

---

## 🛡️ Security

- **The default backup contains no secret values** — a hard invariant, enforced at export
- **Not exported**: API Keys / passwords / tokens / cookies / sessions / device unique ID / logs & cache / plugin binaries
- **A ZIP is untrusted input**: defends against Zip Slip, malicious paths, zip bombs, corrupt archives — any trigger rejects the whole file
- **Logs are fully redacted** — secret values never reach logs
- **Encrypted backup**: scrypt + AES-256-GCM; the password lives in memory only

---

## 🤝 Compatibility

| Status | Meaning |
|---|---|
| ✅ Excellent | Same platform, complete sections, supported schema |
| 👍 Good | Backup from an older DSH |
| ⚠️ Partial | Cross-platform / missing sections / backup newer than target |
| ❌ Unsupported | Schema beyond the supported range (cannot import) |

---

## ❓ FAQ

**Q: Will my API Key be in the backup?**
No. The default backup **never contains any secret value** — only records which keys you'll need to re-enter.

**Q: Will importing overwrite my existing config?**
Not silently. Conflicts ask you to choose (Keep Current / Use Imported); the target is auto-backed-up and can roll back.

**Q: Does it work across platforms (Windows → macOS)?**
Yes. Dead absolute paths are detected and remapped (batch replacement supported).

**Q: Can a corrupted ZIP still be imported?**
No. A checksum mismatch rejects the import outright (protects against corruption or tampering).

**Q: Will re-importing duplicate things?**
No. Items are deduplicated by stable IDs (plugin ID / MCP name / skill name…); existing items are skipped.

---

## 👨‍💻 For developers

```bash
npm install --legacy-peer-deps   # install dependencies
npm run typecheck                # type checking
npm run build                    # build (host lib/ + client bundle)
npm test                         # run tests (192)
npm run bundle                   # rebuild the client bundle only
```

**Architecture**: the core engine is decoupled from the DSH runtime (mock-testable) → per-category adapters → security modules → centralized schema migrations.

**Auto-publish**: push a tag → automatically published to npm (GitHub Actions + OIDC, no stored secrets):

```bash
npm version patch          # 0.1.2 → 0.1.3
git push origin main --tags   # CI: test → build → publish
```

> One-time OIDC trusted-publisher setup:
> ```bash
> npm login
> npm trust github dsh-config-manager --file publish.yml --repo xiajiajun516/dsh-config-manager --allow-publish
> ```
> Or add the GitHub Actions trusted publisher on the package page (Settings → Publishing access).

---

## 🧪 Testing

**All 192 tests pass** (Node's built-in test runner, zero extra dependencies), covering:

| Category | Coverage |
|---|---|
| Export | normal / empty / large / Unicode & special chars / secret filtering |
| Import | normal / merge / replace / skip / conflict / missing plugin / missing dependency / missing secret |
| Rollback | mid-flight failure → everything restored |
| Security | malicious ZIP / corrupt archive / checksum mismatch / path traversal |
| Cross-platform | Windows ↔ macOS ↔ Linux path handling |
| Migration | schema upgrade mechanism |

---

## 📋 Known limitations

1. **Workspace: create/rename title only** — DSH has no whole-overwrite write channel; paths & session lists are maintained by DSH itself (path mapping adapts cross-device)
2. **Some DSH core packages are not public** — features depending on their APIs only work in a local DSH; install needs `--config.auto-install-peers=false`
3. **No MCP management API** — MCP is imported as config lines and takes effect after restarting DSH
4. **Plugin install requires a restart**
5. **Browser UI state (localStorage) is not migrated** — e.g. task board data, panel widths
6. **keybindings / workflows / commands / rules** — DSH has no such concepts; no fake sections
7. **Credential values can't be rolled back** — re-enter manually after a rollback that touched them
8. **Newly created items can't be rollback-deleted** — DSH settings have no delete semantics
9. **Schema migration** — the mechanism is ready; the v1→v2 chain is a placeholder (v1 is current)
10. **History/session migration is off by default** — v1 copies files only
11. **Encrypted backups** — a lost password means the `secrets.enc` can't be decrypted (by design)

---

**Product principles**: better to migrate one config less than to break your existing config. Every import follows `Analyze → Preview → Backup → Apply → Validate → Rollback(if needed)`; every secret follows `never export by default / never log / never expose / never silently transfer`.
