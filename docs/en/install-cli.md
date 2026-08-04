# marveen-install CLI

The `./install.sh` wrapper invokes the `marveen-install` command, which is shipped from the `@marveen/install` npm package. The CLI handles installation, maintenance, and diagnostics for Marveen through a single, platform-independent binary.

## Overview

- **Binary**: `marveen-install` (the `packages/install` package's `dist/cli.js` entry point)
- **Package**: `@marveen/install` (npm registry)
- **Runtime**: Node.js 20+ or Bun 1.x
- **Platforms**: macOS (Darwin) and Linux (Ubuntu/Debian/Fedora/RHEL)
- **Language**: Hungarian by default, English with `--lang en`
- **Colors**: enabled by default, disable with `--no-color`

`marveen-install` is built on `commander` and automatically instantiates `LinuxProvider` (systemd, apt/dnf/yum) or `MacosProvider` (launchd, brew) based on `process.platform`. The user experience is unified across platforms through a single binary and a single command tree.

## Command Tree

```
marveen-install
├── install           [default flow]
├── uninstall
├── status
├── doctor
├── provider
└── update
```

## Subcommand Reference

### install

Runs the full Marveen installation flow: prerequisites, bun, Claude Code, personal info, dependencies, build, provider selection, Ollama discovery, Vault push, system service, bumblebee, summary.

Options:
- `-p, --port <port>`: Dashboard port (1-65535, default: 3420).
- `--skip-update`: Skip the Marveen update step.
- `--provider <id>`: Pre-select the provider (anthropic|minimax|deepseek|openrouter|ollama|skip).
- `--non-interactive`: Headless mode (CI, automation); prompts fall back to defaults.
- `-h, --help`: Show help.

Example:
```bash
./install.sh install --port 3421 --non-interactive
```

### uninstall

Removes the Marveen installation: stops and disables services, deletes launchd/systemd unit files, deletes `.env` and `dist` files, and writes the `uninstalledAt` timestamp to the `~/.config/marveen-installer/` state.

A confirmation prompt is shown unless `--non-interactive` is set. Includes a rollback branch if any step fails partway.

### status

Prints the runtime status of every service in a table (cli-table3): service name, state (active/inactive/failed/unknown), PID, last started.

Example:
```bash
./install.sh status
```

### doctor

Runs seven checks and reports green/yellow/red status for each:

1. OS version
2. Bun installed
3. Claude Code installed
4. Node version
5. Service state
6. Vault reachable
7. Dashboard reachable

Example:
```bash
./install.sh doctor
```

### provider

Re-runs only the model-provider selection (including the Vault push). Skips the rest of the install flow. Useful when the initial install skipped the provider step, or when switching providers (e.g. from Anthropic to Ollama).

Example:
```bash
./install.sh provider
```

### update

Updates Marveen to the latest release: `git pull`, `bun install`, `bun build`, `systemctl restart` / `launchctl kickstart`. Offers rollback if the build or service start fails.

Example:
```bash
./install.sh update
```

## Options Reference

| Option | Description | Command |
|--------|-------------|---------|
| `-h, --help` | Show help | all |
| `--lang <hu\|en>` | Language (default: `hu`) | global |
| `--no-color` | Disable colors | global |
| `-V, --version` | Print version | global |
| `-p, --port <port>` | Dashboard port | `install` |
| `--skip-update` | Skip the update step | `install` |
| `--provider <id>` | Pre-select provider | `install` |
| `--non-interactive` | Headless mode | all |

## Environment Variables

| Variable | Effect |
|----------|--------|
| `MARVEEN_LANG` | Overrides the `--lang` flag (`hu` or `en`). |
| `NO_COLOR` | When non-empty, disables CLI colors. |
| `WEB_PORT` | Dashboard port (default: 3420). |
| `DASHBOARD_TOKEN` | Dashboard bearer token. If unset, reads from `store/.dashboard-token`. |
| `MARVEEN_LOCAL` | When `1`, runs the local `packages/install/dist/cli.js` build instead of `bunx`/`npx`. |

## Examples

Quick install in Hungarian, default port:
```bash
./install.sh
```

Install on a custom port, headless, with a pre-selected provider:
```bash
./install.sh install --port 3421 --non-interactive --provider anthropic
```

Run diagnostics:
```bash
./install.sh doctor
```

Switch provider from Anthropic to Ollama:
```bash
./install.sh provider
# then choose "5. Ollama (local)" in the prompt
```

Update to the latest version:
```bash
./install.sh update
```

Uninstall without confirmation (CI only):
```bash
./install.sh uninstall --non-interactive
```

English help:
```bash
./install.sh --lang en install --help
```
