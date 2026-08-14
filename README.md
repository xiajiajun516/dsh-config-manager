# DSH Config Manager

**Backup · Export · Import · Migrate · Restore** — A configuration backup / export / import / migration manager for DSH.

[English](README.md) | [简体中文](README.zh-CN.md)

One-click export of your main DSH configuration to a ZIP file, import it on another DSH, and restore your working environment as completely as possible.

> ⚠️ **Security first: no Secret (API Key / Token / Password) is exported by default.** See [Security](#security).

---

## What it does

DSH configuration is a hybrid model — one central `settings.yaml` plus multiple standalone files plus plugin-owned files (see `Docs/research/dsh-architecture.md`).
This plugin does **not** copy `~/.dsh` wholesale. Instead it collects configuration by real config categories, packages them into a ZIP backup with a manifest and checksums, and runs a safe import flow on the target side:

```
Analyze → Preview → Snapshot → Apply → Validate → Rollback(if needed)
```

## Features

- **Export**: Quick Export (one-click recommended config) and per-section custom export.
- **Import**: ZIP validation → manifest read → integrity check → schema check → compatibility check → content scan → import-plan preview → user confirmation → automatic snapshot → apply → validate → result (automatic rollback on failure).
- **Dry Run / Preview**: `analyzeImport()` + `createImportPlan()` are pure computation with zero writes — full preview before importing.
- **Conflict handling**: global strategies `merge` (default) / `replace` / `skipExisting` plus per-item `Keep Current / Use Imported / Review`.
- **Path mapping**: cross-device absolute-path detection and batch prefix mapping (workspace paths / MCP cwd / plugin config paths).
- **Secret safety**: all sensitive fields are stripped by default; encrypted full backup (scrypt + AES-256-GCM) is an opt-in advanced feature.
- **Automatic snapshot & rollback**: backs up the target state before import and restores it in reverse order on failure.
- **Schema versioning & migration**: independent `schemaVersion`, migration logic centralized in `src/migrations/`.
- **Idempotency**: re-importing the same ZIP creates no duplicates (keyed by Plugin ID / MCP serverName / Prompt name / Workspace id / Credential ref).
- **Compatibility score**: Excellent / Good / Partial / Unsupported (rule-driven).
- **Profiles**: save current config as a Profile / switch / duplicate / rename / export / import / delete; switching includes Preview + snapshot + rollback (`src/profiles/`).

## Installation

This plugin is a standard **DSH bundle plugin** (mirrors the dsh-ssh engineering pattern, research report §5.1): `package.json` declares
`dsh.bundle.patch` (pointing to `cordis.patch.yml`, the CLI bundle hard criterion) and `dsh.client` (browser-half declaration);
`npm run build` produces both halves (`lib/index.js` host half + `lib/client.js` browser half, the latter loaded into the Web GUI via
`window.__ModuleLoader__.load(...)`).

Two install options (choose one):

```bash
# ① Install from a local tgz / directory (recommended, after build)
npm run build
npm pack                       # produces dsh-config-manager-0.1.0.tgz
dsh plugin --profile web add file:/absolute/path/to/dsh-config-manager-0.1.0.tgz

# ② Install from a registry after publishing
dsh plugin --profile web add dsh-config-manager
```

> **`--legacy-peer-deps` note**: some DSH core packages in peerDependencies (e.g.
> `@deepseek-ai/dsh-plugin-marketplace`, `dsh-host-plugin-inventory`) are not published to the public npm registry
> and only exist in a local DSH profile. If npm/pnpm fails while resolving peer dependencies, skip automatic peer installation:
> - Direct npm install: `npm install --legacy-peer-deps`
> - `dsh plugin add` (forwards to pnpm internally): `dsh plugin --profile web add <spec> --config.auto-install-peers=false`
>
> At runtime these packages are provided by the DSH profile itself (peerDependencies semantics); the plugin never reinstalls them.

> **Local verification tip**: isolate testing with the `$DSH_HOME` environment variable — never touches `~/.dsh`:
> ```bash
> $env:DSH_HOME = "D:\tmp\dsh-home"        # Windows PowerShell
> dsh plugin --profile test add file:<tgz> --config.auto-install-peers=false
> dsh --profile test --dump-config | Select-String config-manager   # should show the mount line
> ```

## Export

Two modes:

- **Quick Export**: one-click export of the recommended sections (settings / ui / providers / plugins / mcp / prompts / skills / agentPresets / workspaces / credentialsStatus).
- **Custom Export**: choose sections individually (`pluginFiles` and `sessions` are opt-in; `sessions` is off by default).

Output: `dsh-config-<yyyy-MM-dd>.zip` containing `manifest.json` + per-section data + `integrity/checksums.json` (SHA-256).

## Import

```
Select ZIP → Validate ZIP → Read Manifest → Check Integrity → Check Schema
→ Check Compatibility → Scan Contents → Generate Import Plan → Show Preview
→ User Confirms → Create Backup (Snapshot) → Import → Validate → Show Result
```

Import flow is enforced: **no writes happen before confirmation**; **a snapshot is always created before importing**; on failure `rollbackOnError` decides between full rollback or per-item honest reporting.

## Security

> **The default backup contains no Secret values.** This is a hard security invariant, enforced by the `Exporter`:

- All structured section data passes a sensitive-field scan before being written to the ZIP (field-name blacklist: password / token / apiKey / secret / credential / authorization / cookie / privateKey / clientSecret etc., case-insensitive); matches are stripped.
- `ctx.settings.describe({ redactSecrets: true })` is the first line of defense for DSH-known secrets; the sensitive-field scanner is the second line of defense for plugin-defined fields.
- Credentials (`.credentials.yaml`) **never export values**, only state (`{ref, required, configured, hasValue:false}`); after import a "N credentials need attention" list is generated.
- **Encrypted full backup (optional)**: when "Include secrets" is explicitly checked, a backup password is required; `node:crypto` (scrypt KDF + AES-256-GCM) is used, **the password is never written to the manifest**; `secrets.enc` is only written back via `ctx.credentials.set()` after decryption.
- Without an encryption provider, `includeSecrets: true` is rejected (secrets are never leaked in plaintext).
- Logging is fully redacted — Secret values never reach logs.
- A ZIP is untrusted input: defends against Zip Slip / absolute paths / symlinks / zip bombs (entry count / compressed size / uncompressed size / compression-ratio limits) / malformed ZIPs / checksum mismatch — any trigger rejects the whole archive.

## What is NOT exported

By default **not** exported (spec §34.19/20):

- API Key / Password / Token / Cookie / Session / auth credentials (values)
- `~/.dsh/.anonymous-user-id` (device unique ID)
- Conversation history (`sessions/`, off by default; v1 supports file-level copy only)
- Logs / Cache / temp files
- Browser localStorage UI state (no host-side channel; only `uiMigrationNotes` is exported)
- Plugin binaries (never packaged — only the manifest is migrated, install goes through the official mechanism)

## Secrets

| Backup type | Import behavior |
|---|---|
| Normal backup (no secrets.enc) | All credentials → `MissingSecret`, filled in by the user after import |
| Encrypted backup + correct password | Auto-decrypted and restored via `credentials.set()` (per-item confirmation in preview) |
| Encrypted backup + no password | Same as normal backup: state-only, user fills in |

## Compatibility

| Status | Rule |
|---|---|
| Excellent | Same platform, no missing sections, supported schema |
| Good | Backup from an older DSH (target is backward compatible) |
| Partial | Cross-platform / missing sections / backup newer than target |
| Unsupported | Schema beyond the supported range |

## Backup format

```
dsh-config-2026-08-14.zip
├── manifest.json                  # schemaVersion / exporter / source / sections / security
├── config/settings.json           # non-UI settings namespaces (redacted + revision)
├── config/ui.json                 # UI namespaces + uiMigrationNotes
├── ai/providers.json              # llm-* providers/models (same section, not split)
├── plugins/plugins.json + patch.json
├── mcp/servers.json               # dsh-mcp-client entries extracted from the composed patch
├── custom/prompts.json + skills/
├── agents/presets/
├── workspaces/workspaces.json
├── plugin-files/                  # optional
├── security/credentials.json      # credential state (never contains values)
├── security/secrets.enc           # encrypted backups only
└── integrity/checksums.json       # SHA-256
```

## Development

```bash
npm install --legacy-peer-deps   # peers include DSH core packages not on the public registry, see Installation
npm run typecheck                # tsc --noEmit
npm run build                    # tsc -p tsconfig.build.json (host half lib/) + tsdown (client bundle lib/client.js)
npm run bundle                   # rebuild the client bundle only (tsdown)
npm test                         # node --test "src/**/*.test.ts" "tests/**/*.test.ts"
```

Architecture: the core engine (`src/core`) depends only on the `ConfigAdapter` / `HostContext` interfaces (decoupled from the DSH runtime, testable with in-memory mocks); `src/adapters` implements each config category; `src/security` provides secret scanning / encryption / integrity / ZIP safety / redaction; `src/migrations` centralizes schema migration.

## Testing

Test framework: **node:test (Node built-in, zero dependency)**, following the choice made in the core module (no vitest). Tests live in `src/**/*.test.ts` and `tests/**/*.test.ts`.

Coverage matrix (spec §33 + acceptance scenarios A–G):

| Group | Coverage |
|---|---|
| Export | normal / empty / large (1MB+) / Unicode / special characters / secret filtering |
| Import | normal / Merge / Replace / Skip (never deletes target-only items, §32) / Conflict / Missing plugin / Missing dependency / Missing secret / unconfirmed rejection |
| Rollback (scenario E) | multi-adapter mid-flight failure → full restore (settings / file blobs / workspace / patch lines); `rollbackOnError=false` comparison; honest partial-rollback report |
| Migration (scenario G) | `migrateToCurrent` mechanism-level: same version / too new / below minimum / no path / registry overlap / chained progression (**honest note: v1 is current, no real v2 exists for end-to-end verification**) |
| Security (scenario F) | malformed ZIP / oversized entry count / checksum mismatch & missing / Zip Slip / absolute paths |
| Cross-platform (scenario B) | win32→darwin / darwin→win32 / linux→win32 batch prefix mapping |
| Redaction | log messages / meta / full pipeline never leaks secret values |
| Schema | manifest structure validation / version predicate functions |

Current test results: **186 tests, all passing** (`npm test`); `npm run typecheck` and `npm run build` both pass.

## Known limitations

1. **Workspace: create/rename title only**: DSH's workspace service has no "overwrite whole" write channel — import can create workspaces and update titles; paths and session lists are maintained by DSH itself from the real directory, cross-device paths are adapted via path mapping.
2. **Some DSH core packages are not on the public npm registry** (e.g. `@deepseek-ai/dsh-plugin-marketplace`, `dsh-host-plugin-inventory`): features depending on their APIs only work in a local profile; installing this plugin requires skipping automatic peer installation (see the `--legacy-peer-deps` note in [Installation](#installation)).
3. **No MCP management API** (research report §4.3): MCP is imported as composed patch lines and takes effect after restarting DSH; no add/remove/update API.
4. **Plugin installation requires a restart**: `pluginMarketplace.installPlugin` only returns `needsRestart`; restarting depends on DSH Desktop.
5. **Browser localStorage UI state is not migrated** (task board data, panel widths, etc.): no host channel.
6. **keybindings / workflow configs / commands / rules files**: DSH currently has no such concepts; no sections are implemented (nothing invented).
7. **Credential values cannot be rolled back**: DSH never reads credential values back; credentials overwritten during import can only be marked `manualHint` for manual re-entry on rollback.
8. **Newly created items cannot be rollback-deleted**: DSH settings have no delete semantics; namespaces newly created by import can only be handled manually on rollback (honestly reported as partial).
9. **Schema migration**: v1→v2 is a placeholder (current `CURRENT_SCHEMA_VERSION=1`); the mechanism is ready but no real v2 exists to verify.
10. **History/session migration**: off by default; v1 supports file-level copy only.
11. **Encrypted backups**: depend on a strong user-set password; a lost password makes `secrets.enc` undecryptable (by design).

## Manual Test (shortest manual flow)

> Prerequisites: two DSH instances (or two config directories on one machine); this plugin built and installed per [Installation](#installation).

```
DSH A
→ open Config Manager → Export Configuration
→ choose Quick Export → export dsh-config-<date>.zip (confirm in the report that Secrets are all excluded)
→ copy the ZIP to DSH B

DSH B
→ open Config Manager → Import Configuration
→ select the ZIP → wait for Analyzing... → review the Import Preview (sections/plugins/path mapping/credential re-entry list)
→ if there are path issues → choose mapping directories (batch prefix mapping)
→ resolve conflicts (Keep Current / Use Imported / Review)
→ confirm Import → watch progress → review the result report
→ fill in missing credentials (N credentials need attention)
→ Verify: settings / plugins / MCP / Prompts / Skills / Workspaces are restored;
    if the import failed midway → confirm it rolled back automatically and the original config still works
```

---

**Product principles**: better to migrate one config less than to break a user's existing config. Every Import follows `Analyze → Preview → Backup → Modify → Validate → Rollback`; every Secret follows `never export by default / never log / never expose / never silently transfer`.
