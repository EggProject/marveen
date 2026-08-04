# marveen-install CLI

A `./install.sh` wrapper a `marveen-install` parancsot indítja, amely a `@marveen/install` npm csomagból töltődik le. A CLI a Marveen telepítését, karbantartását és diagnosztikáját látja el egyetlen, platform-független binárisként.

## Áttekintés

- **Bináris**: `marveen-install` (a `packages/install` csomag `dist/cli.js` binárisa)
- **Csomag**: `@marveen/install` (npm registry)
- **Runtime**: Node.js 20+ vagy Bun 1.x
- **Platform**: macOS (Darwin) és Linux (Ubuntu/Debian/Fedora/RHEL)
- **Nyelv**: magyar (alapértelmezett) vagy angol (`--lang en`)
- **Színek**: alapértelmezetten bekapcsolva (`--no-color` kapcsolóval kikapcsolható)

A `marveen-install` a `commander` könyvtárra épül, és a `process.platform` alapján automatikusan a `LinuxProvider` (systemd, apt/dnf/yum) vagy a `MacosProvider` (launchd, brew) implementációt példányosítja. A user-oldali élmény egy binárison és egy command tree-n keresztül egységes.

## Parancsfa

```
marveen-install
├── install           [alapértelmezett flow]
├── uninstall
├── status
├── doctor
├── provider
└── update
```

## Szubparancsok

### install

Telepíti a Marveen-t a teljes flow-n keresztül: előfeltételek, bun, Claude Code, személyes adatok, függőségek, build, provider-választás, Ollama felfedezés, Vault push, rendszerszolgáltatás, bumblebee, összefoglaló.

Opciók:
- `-p, --port <port>`: Dashboard port (1-65535, alapértelmezett: 3420).
- `--skip-update`: A Marveen frissítésének kihagyása.
- `--provider <id>`: Előre megadott provider (anthropic|minimax|deepseek|openrouter|ollama|skip).
- `--non-interactive`: Fej nélküli mód (CI, automation); a promptok default értéket vesznek.
- `-h, --segítség`: Súgó megjelenítése.

Példa:
```bash
./install.sh install --port 3421 --non-interactive
```

### uninstall

Eltávolítja a Marveen telepítést: leállítja és letiltja a service-eket, törli a launchd/systemd unit-eket, törli a `.env` és a `dist` fájlokat, beállítja az `uninstalledAt` timestamp-et a `~/.config/marveen-installer/` state-ben.

Megerősítő promptot kér, kivéve `--non-interactive` módban. Rollback ágat tartalmaz, ha bármely lépés félbeszakad.

### status

A futó szolgáltatások állapotát írja ki táblázatos formában (cli-table3): service név, állapot (active/inactive/failed/unknown), PID, utolsó indítás.

Példa:
```bash
./install.sh status
```

### doctor

Hét ellenőrzést futtat le, és zöld/sárga/piros státusszal jelzi az eredményt:

1. OS verzió
2. Bun telepítve
3. Claude Code telepítve
4. Node verzió
5. Service állapot
6. Vault elérhető
7. Dashboard elérhető

Példa:
```bash
./install.sh doctor
```

### provider

Csak a modell-szolgáltató újraválasztását futtatja (a Vault push-t is beleértve). A többi telepítési lépést kihagyja. Akkor hasznos, ha a kezdeti telepítéskor kihagytad a provider-választást, vagy váltani szeretnél (pl. Anthropic-ról Ollama-ra).

Példa:
```bash
./install.sh provider
```

### update

Frissíti a Marveen-t a legújabb release-re: `git pull`, `bun install`, `bun build`, `systemctl restart` / `launchctl kickstart`. Rollback lehetőséget is kínál, ha a build vagy a service indítás nem sikerül.

Példa:
```bash
./install.sh update
```

## Opciók referencia

| Opció | Leírás | Parancs |
|-------|--------|---------|
| `-h, --segítség` | Súgó megjelenítése | minden |
| `--lang <hu\|en>` | Nyelv (alapértelmezett: `hu`) | globális |
| `--no-color` | Színek kikapcsolása | globális |
| `-V, --version` | Verzió kiírása | globális |
| `-p, --port <port>` | Dashboard port | `install` |
| `--skip-update` | Frissítés kihagyása | `install` |
| `--provider <id>` | Előre megadott provider | `install` |
| `--non-interactive` | Fej nélküli mód | minden |

## Környezeti változók

| Változó | Hatás |
|---------|-------|
| `MARVEEN_LANG` | Felülírja a `--lang` kapcsolót (`hu` vagy `en`). |
| `NO_COLOR` | Ha nem üres, a CLI színek kikapcsolnak. |
| `WEB_PORT` | A dashboard portja (alapértelmezett: 3420). |
| `DASHBOARD_TOKEN` | A dashboard bearer token. Ha nincs, a `store/.dashboard-token` olvassa. |
| `MARVEEN_LOCAL` | Ha `1`, a `packages/install/dist/cli.js` lokális buildje fut a `bunx`/`npx` helyett. |

## Példák

Gyors telepítés magyarul, alapértelmezett porton:
```bash
./install.sh
```

Telepítés egyedi porton, headless módban, előre megadott provider-rel:
```bash
./install.sh install --port 3421 --non-interactive --provider anthropic
```

Diagnosztika futtatása:
```bash
./install.sh doctor
```

Provider váltás Anthropic-ról Ollama-ra:
```bash
./install.sh provider
# majd a promptban válaszd az "5. Ollama (lokális)" opciót
```

Frissítés a legújabb verzióra:
```bash
./install.sh update
```

Eltávolítás megerősítés nélkül (csak CI-ben használd):
```bash
./install.sh uninstall --non-interactive
```

Angol nyelvű help:
```bash
./install.sh --lang en install --help
```
