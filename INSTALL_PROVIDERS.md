# Provider-választás és Vault push

A Marveen telepítő egy legördülő menüből kéri el a modell-szolgáltatót (Anthropic, MiniMax, DeepSeek, OpenRouter, Ollama, Kihagyás), és a kiválasztott credentialt a **Vault**-ba írja át HTTPS POST-tal. A `.env` fájl így nem tartalmaz plaintext API kulcsot — az csak az operátor shell RC-jét és a nem-érzékeny konfigurációt szolgálja.

## Miért a Vault?

- A Vault titkosítva tárol (AES-256-GCM), a master key macOS-en a Keychain-ben, Linuxon fájl-alapú fallback.
- A dashboard `Beállítások` és `Vault` oldalakon a titkok menedzselhetők, cserélhetők, auditálhatók.
- A telepítő soha nem ír API kulcsot a `.env`-be, így a `.env` példány kompromittálódása nem jelent kulcs-szivárgást.
- A provider váltás nem igényli a `.env` kézi szerkesztését, és nincs szolgáltatás-újraindítás a kulcsok cseréjéhez.

## Támogatott providerek

| Provider | Mód | Szükséges input |
|----------|------|-----------------|
| Anthropic Claude | API key | `ANTHROPIC_API_KEY` (sk-ant-...) |
| Anthropic Claude | OAuth (headless) | `CLAUDE_CODE_OAUTH_TOKEN` (sk-ant-oat01-...) |
| MiniMax | API token | `MINIMAX_API_KEY` (region: global vagy china) |
| DeepSeek | API key | `DEEPSEEK_API_KEY` |
| OpenRouter | API key | `OPENROUTER_API_KEY` |
| Ollama | base URL | `OLLAMA_BASE_URL` (alapértelmezett: http://localhost:11434) |
| Kihagyás | — | nincs — a telepítés provider nélkül folytatódik |

## Telepítési flow

1. A telepítő a `provider-prompt` lépésben megjeleníti a legördülő menüt.
2. A felhasználó kiválasztja a kívánt providert.
3. A `promptX` függvény (`@inquirer/prompts`) validálja a bemenetet (formátum, hossz, prefix).
4. A `vault-push` lépés `POST /api/vault` hívással pusholja a credentialt a Vault-ba.
5. Ha a provider base URL-t is igényel (Ollama), a `POST /api/settings` hívással a settings végpontra is ír.
6. A telepítő sikerüzenettel zár, ha a Vault `200 OK`-kal válaszol.

## Vault push payload

A `POST /api/vault` hívás JSON body-ja:

```json
{
  "id": "ANTHROPIC_API_KEY",
  "label": "Anthropic API key",
  "value": "sk-ant-..."
}
```

A `POST /api/settings` hívás (pl. Ollama esetén):

```json
{
  "key": "OLLAMA_BASE_URL",
  "value": "http://localhost:11434",
  "actor": "installer"
}
```

A `Authorization` header minden esetben `Bearer <DASHBOARD_TOKEN>` formátumban küldi a tokent.

## Provider váltás a telepítés után

A `marveen-install provider` szubparancs kizárólag a provider-konfigurációt írja újra, a többi telepítési lépést kihagyja. A futó service-ek nem indulnak újra; a Vault frissítését a dashboard `Beállítások` oldalról vagy a `marveen-install provider` újbóli futtatásával lehet érvényesíteni.

```bash
./install.sh provider
```

A parancs ugyanazt a `promptX` → `vault-push` flow-t futtatja, mint az eredeti telepítés, de az előfeltételek, a build és a service-install lépések kimaradnak.

## Hibakezelés

- Ha a Vault `401 Unauthorized` státusszal válaszol, a telepítő leáll és hibaüzenetet ír ki. A `DASHBOARD_TOKEN` környezeti változó vagy a `store/.dashboard-token` ellenőrzése szükséges.
- Ha a Vault `5xx` státusszal válaszol, a telepítő szintén leáll; a dashboard `Beállítások` oldaláról utólag is bevihetők a titkok.
- Ha a provider bemenet formátuma nem megfelelő (pl. `MINIMAX_API_KEY` rövidebb, mint 20 karakter), a `validate` függvény magyar hibaüzenettel utasítja el a választ, és a prompt újra megjelenik.

## Biztonsági megjegyzések

- A Vault push kizárólag `http://127.0.0.1:<port>`-ra küld, soha nem távoli endpointra.
- A `DASHBOARD_TOKEN` a `store/.dashboard-token` (mode 0600) fájlból olvasódik, vagy a környezeti változóból.
- A provider credential soha nem íródik a `.env`-be, a telepítési log-ba, vagy a `git diff`-be.
- A `vault-id` (pl. `ANTHROPIC_API_KEY`) a `~/.config/marveen-installer/installer-state.json` state fájlban tárolódik, hogy a `provider` szubparancs tudja, melyik kulcsot kell frissítenie.
