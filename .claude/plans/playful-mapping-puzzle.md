# D — channel-provider class extraction (lowest-risk, real OOP)

## Context

A `docs/refactor-to-classbase/` 8 subsystemje közül a **D (channel-provider)** a legjobb OOP célpont:

- **5 implementation ugyanazon `ChannelProvider` interface-nek** — valódi polimorfizmus (telegram, slack, discord, googlechat, teams)
- **UnsupportedDirectSendProvider abstract base** dedup a googlechat/teams párra (100% method body sharing — egyetlen valódi dedup a fájlban)
- **`withTestRunMarking` decorator → Form B (explicit-delegation function)** — a DR2 spread-on-class hazard kikerülése
- **18 production importer + 17 test mock** — a `getProvider(type)` és `markedProviders` byte-identical marad, tehát a fogyasztók NEM TÖRNEK EL

A user kritikája a G.1 wrapper-re: a class nem volt USED. A D ezt orvosolja — a class-ok a `markedProviders` singleton instance-k formájában USED-ek, a `getProvider()` rajtuk keresztül visszaadja őket, és minden eddigi fogyasztó működik.

**Előzmény:** A korábbi G.1 commit (`13a0f5e`) revertálva lett a `bd94d2c`-ben (a user szabálya: tilos a git tree módosítása a user kérése nélkül). A `13a0f5e` SHA megmaradt history-ban; a branch HEAD most `bd94d2c`, working tree baseline.

## Scope

### Érintett fájl: kizárólag 1
- `src/channel-provider.ts` (551 LOC a `wc -l` mérés alapján — a terv 552-vel számolt, off-by-1; a forrás 551)

### NEM érintett (szándékosan, per a review-k ajánlásai)
- `src/notify.ts` — `getProvider` import továbbra is működik (a szignatúra byte-identical)
- `src/config.ts:325-326` — `getChannelToken` / `getChannelChatId` hívások érintetlenek (a free function wrapper-ök megmaradnak, a D.5 ezen változtatna, de most csak D.4+D.2)
- 18 másik production importer (4 top-level + 2 channel-coordinator + 14 web/) — `getProvider` szignatúra byte-identical
- 17 test mock — a mock factory-k `getProvider`-t stubolnak, ami továbbra is működik
- `src/format.ts`, `src/test-run-marker.ts`, `src/env.ts` — unchanged
- A `src/channel-coordinator/` subcluster — out of D scope (CE-D1)
- `src/web/federation/` — out of D scope

## Tervezett commit-sorrend: 2 commit, D.4 → D.2

Per `05-refactor-roadmap.md:139` (DR2 mitigation #5): **D.4-nek meg kell előznie D.2-t commit-sorrendben**, mert a spread `{ ...provider }` a `withTestRunMarking:490`-ben **silently drops prototype methods** amint a provider-ek class-ok lesznek. Két külön commit:
1. **D.4** — `withTestRunMarking` Form B (explicit-delegation function). Behavior-preserving object literal-okon. Low risk.
2. **D.2** — 5 frozen object literal → 5 class + 1 abstract base. A D.4 commit után a decorator biztonságos.

Két commit azért jobb mint egy, mert:
- D.4 kis, alacsony kockázatú, önállóan revertálható
- D.2 közepes kockázatú, de a D.4 commitra támaszkodik (ha D.4 visszavonásra kerül, D.2 is revertálódik)
- A két commit granular rollback-ot ad

---

## Commit 1 — D.4: `withTestRunMarking` Form B (explicit-delegation function)

**Cél:** A `withTestRunMarking:490-498` spread `{ ...provider, sendMessage, sendPhoto }` lecserélése explicit-delegation függvénnyé, amely minden 11 interface membert felsorol. A D.2 commit előtt EZ KELL, különben a spread a class instance-eken undefined-ot ad vissza `formatMessage` / `splitMessage` / `validateToken` metódusokra (DR2 critical hazard).

**File:** `src/channel-provider.ts`

**Régi kód (L490-498):**
```ts
function withTestRunMarking(provider: ChannelProvider): ChannelProvider {
  return {
    ...provider,
    sendMessage: (token, chatId, text, parseMode) =>
      provider.sendMessage(token, chatId, markIfTestRun(text), parseMode),
    sendPhoto: (token, chatId, photoPath, caption) =>
      provider.sendPhoto(token, chatId, photoPath, markIfTestRun(caption)),
  }
}
```

**Új kód (Form B, per `03-class-boundaries.md §D4`):**
```ts
function withTestRunMarking(provider: ChannelProvider): ChannelProvider {
  return {
    type: provider.type,
    pluginId: provider.pluginId,
    pluginPaneId: provider.pluginPaneId,
    envKeys: provider.envKeys,
    stateDir: provider.stateDir,
    chatIdFormat: provider.chatIdFormat,
    sendMessage: (token, chatId, text, parseMode) =>
      provider.sendMessage(token, chatId, markIfTestRun(text), parseMode),
    sendPhoto: (token, chatId, photoPath, caption) =>
      provider.sendPhoto(token, chatId, photoPath, markIfTestRun(caption)),
    validateToken: (token) => provider.validateToken(token),
    formatMessage: (text) => provider.formatMessage(text),
    splitMessage: (text) => provider.splitMessage(text),
  }
}
```

**Megjegyzések:**
- A függvény neve `withTestRunMarking` marad (nem exportált, csak a `markedProviders:500-506` hívja).
- A `markIfTestRun` import (L7) változatlan marad.
- A return-type annotáció `ChannelProvider` (L490) megmarad — ez a compile-time gate.
- A spread eltávolítása a lényeges változás; az explicit member-enumeration biztosítja, hogy class instance-eken is működjön (D.2 után).

**Kockázat:** Low (Form B per `03 §D4`). Object literal provider-eken behavior-identical (a spread is saját tulajdonságokat copy-zott, és minden member az object literal-okban saját tulajdonság volt).

**Verification gates (D.4 commit):**
- `bun tsc --noEmit` → exit 0
- Lint a `channel-provider.ts`-ra → 34 pre-existing error marad, **0 új**
- `node_modules/.bin/vitest run src/__tests__/channel-provider.test.ts` → 0 failures (a fájl a readonly field-eken keresztül exercise-el)
- `node_modules/.bin/vitest run` (full suite) → 0 failures, 0 spurious new failures

**Rollback:** Single `git revert <SHA>`. A spread forma visszaáll, object literal provider-eken azonnal működik újra.

---

## Commit 2 — D.2: 5 provider class extraction + abstract base

**Cél:** Az 5 frozen object literal (`telegramProvider:53-104`, `slackProvider:134-228`, `discordProvider:243-311`, `googlechatProvider:324-350`, `teamsProvider:364-391`) átalakítása 5 class-sá + 1 abstract base-sá. A const-ok maradnak, de `new XxxProvider()` instance-ekre cserélődnek. A `withTestRunMarking` (D.4 commit) most biztonságosan alkalmazható class instance-ekre.

**File:** `src/channel-provider.ts`

**Új class declarations (a fájl végéhez fűzve, vagy a megfelelő provider literal ELŐTTE):**

```ts
export interface ValidateTokenResult {
  readonly ok: boolean
  readonly botName?: string
  readonly error?: string
}

export class TelegramProvider implements ChannelProvider {
  readonly type = 'telegram' as const
  readonly pluginId = 'telegram@claude-plugins-official'
  readonly pluginPaneId = 'plugin:telegram:telegram'
  readonly envKeys: readonly string[] = ['TELEGRAM_BOT_TOKEN']
  readonly stateDir = 'telegram'
  readonly chatIdFormat = 'numeric (e.g. 1268077055)'

  async sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void> {
    const payload: Record<string, string> = { chat_id: chatId, text }
    if (parseMode) payload.parse_mode = parseMode
    const body = JSON.stringify(payload)
    await telegramHttpPost(token, 'sendMessage', body, 'application/json')
  }

  async sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void> {
    const fileData = readFileSync(photoPath)
    const boundary = `----FormBoundary${Date.now()}`
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Telegram sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  }

  async validateToken(token: string): Promise<ValidateTokenResult> {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      const data = await resp.json() as { ok: boolean; result?: { username: string; id: number } }
      if (data.ok && data.result) {
        return { ok: true, botName: data.result.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Telegram API' }
    }
  }

  formatMessage(text: string): string {
    return formatForTelegram(text)
  }

  splitMessage(text: string): string[] {
    return splitMessage(text)
  }
}

export class SlackProvider implements ChannelProvider {
  readonly type = 'slack' as const
  readonly pluginId = 'slack-channel@marveen-marketplace'
  readonly pluginPaneId = 'plugin:slack-channel:marveen-marketplace'
  readonly envKeys: readonly string[] = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']
  readonly stateDir = 'slack'
  readonly chatIdFormat = 'Slack channel/DM ID (e.g. C01234ABCDE)'

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: chatId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    })
    if (!resp.ok) {
      throw new Error(`Slack API HTTP ${resp.status}`)
    }
    const data = await resp.json() as { ok: boolean; error?: string }
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`)
    }
  }

  async sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void> {
    const fileData = readFileSync(photoPath)
    const filename = photoPath.split('/').pop() || 'image.png'

    const urlResp = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: `filename=${encodeURIComponent(filename)}&length=${fileData.length}`,
    })
    const urlData = await urlResp.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(`Slack getUploadURL: ${urlData.error || 'unknown error'}`)
    }

    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileData,
    })

    const completeResp = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: caption || filename }],
        channel_id: chatId,
        initial_comment: caption || undefined,
      }),
    })
    const completeData = await completeResp.json() as { ok: boolean; error?: string }
    if (!completeData.ok) {
      throw new Error(`Slack completeUpload: ${completeData.error}`)
    }
  }

  async validateToken(token: string): Promise<ValidateTokenResult> {
    try {
      const resp = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${token}`,
        },
      })
      const data = await resp.json() as { ok: boolean; bot_id?: string; user?: string; error?: string }
      if (data.ok) {
        return { ok: true, botName: data.user || data.bot_id }
      }
      return { ok: false, error: data.error || 'Invalid token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Slack API' }
    }
  }

  formatMessage(text: string): string {
    return formatForSlackMrkdwn(text)
  }

  splitMessage(text: string): string[] {
    return splitMessage(text, SLACK_MAX_MESSAGE_LENGTH)
  }
}

export class DiscordProvider implements ChannelProvider {
  readonly type = 'discord' as const
  readonly pluginId = 'discord@claude-plugins-official'
  readonly pluginPaneId = 'plugin:discord:discord'
  readonly envKeys: readonly string[] = ['DISCORD_BOT_TOKEN']
  readonly stateDir = 'discord'
  readonly chatIdFormat = 'Discord channel ID (e.g. 1234567890123456789)'

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${token}`,
      },
      body: JSON.stringify({ content: text }),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Discord API ${resp.status}: ${body.slice(0, 200)}`)
    }
  }

  async sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void> {
    const fileData = readFileSync(photoPath)
    const filename = photoPath.split('/').pop() || 'image.png'
    const boundary = `----FormBoundary${Date.now()}`
    const parts: Buffer[] = []
    const payloadJson = JSON.stringify({
      content: caption || undefined,
      attachments: [{ id: '0', filename }],
    })
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bot ${token}`,
      },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Discord sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  }

  async validateToken(token: string): Promise<ValidateTokenResult> {
    try {
      const resp = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` },
      })
      const data = await resp.json() as { id?: string; username?: string }
      if (resp.ok && data.username) {
        return { ok: true, botName: data.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Discord API' }
    }
  }

  formatMessage(text: string): string {
    return formatForDiscord(text)
  }

  splitMessage(text: string): string[] {
    return splitMessage(text, DISCORD_MAX_MESSAGE_LENGTH)
  }
}

// Abstract base a googlechat/teams pár dedup-jához (per review-completeness §02.8(a))
export abstract class UnsupportedDirectSendProvider implements ChannelProvider {
  abstract readonly type: ChannelProviderType
  abstract readonly pluginId: string
  abstract readonly pluginPaneId: string
  abstract readonly envKeys: readonly string[]
  abstract readonly stateDir: string
  abstract readonly chatIdFormat: string
  protected abstract readonly displayName: string
  protected abstract readonly maxLength: number

  async sendMessage(): Promise<void> {
    throw new Error(`${this.type}: direct dashboard send not supported (delivery via plugin MCP tools)`)
  }

  async sendPhoto(): Promise<void> {
    throw new Error(`${this.type}: direct dashboard send not supported (delivery via plugin MCP tools)`)
  }

  async validateToken(): Promise<ValidateTokenResult> {
    return { ok: true, botName: this.displayName }
  }

  formatMessage(text: string): string {
    return text
  }

  splitMessage(text: string): string[] {
    return splitMessage(text, this.maxLength)
  }
}

export class GooglechatProvider extends UnsupportedDirectSendProvider {
  readonly type = 'googlechat' as const
  readonly pluginId = 'googlechat@claude-channel-googlechat'
  readonly pluginPaneId = 'plugin:googlechat:googlechat'
  readonly envKeys: readonly string[] = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLECHAT_PROJECT_ID', 'GOOGLECHAT_SUBSCRIPTION']
  readonly stateDir = 'googlechat'
  readonly chatIdFormat = 'space resource name (e.g. spaces/AAAA)'
  protected readonly displayName = 'Google Chat'
  protected readonly maxLength = GOOGLECHAT_MAX_MESSAGE_LENGTH
}

export class TeamsProvider extends UnsupportedDirectSendProvider {
  readonly type = 'teams' as const
  readonly pluginId = 'teams@marveen-marketplace'
  readonly pluginPaneId = 'plugin:teams:marveen-marketplace'
  readonly envKeys: readonly string[] = ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID']
  readonly stateDir = 'teams'
  readonly chatIdFormat = 'Teams conversation id (managed by the plugin per pairing)'
  protected readonly displayName = 'Microsoft Teams'
  protected readonly maxLength = TEAMS_MAX_MESSAGE_LENGTH
}
```

**A const-ok cseréje (a régi object literal-ok helyére):**
```ts
// A 5 frozen object literal törlendő per OE-D4 + CLAUDE.md §3 second clause.
// A const nevek megmaradnak, de class instance-ekre mutatnak:
const telegramProvider: ChannelProvider = new TelegramProvider()
const slackProvider: ChannelProvider = new SlackProvider()
const discordProvider: ChannelProvider = new DiscordProvider()
const googlechatProvider: ChannelProvider = new GooglechatProvider()
const teamsProvider: ChannelProvider = new TeamsProvider()
```

A `markedProviders:500-506` és `getProvider:508-510` **byte-identical marad** (a const nevekre hivatkoznak, amik most class instance-ek).

**Segéd függvények:** A `telegramHttpPost`, `formatForSlackMrkdwn`, `formatForDiscord` free function-ök változatlanok maradnak (a class-ok privát metódusokra konvertálás a review OE-7 miatt nem kell — a free function-ök a module-scope utility-t töltik be).

**Per-method caller table (DR1 mitigation, a review ajánlása):**
| Method | Provider | Production callers | Class file:line (post-D.2) |
|---|---|---|---|
| `sendMessage` | telegram | `notify.ts:22, 31` | ~80 |
| `sendMessage` | slack | `notify.ts:22, 31` (same template) | ~155 |
| `sendMessage` | discord | (same template) | ~225 |
| `sendMessage` | googlechat/teams | NONE (throws) | base class |
| `sendPhoto` | all 5 | `notify.ts` indirectly via plugin | per-provider |
| `validateToken` | all 5 | `agents.ts:968, :1046, :1435` | per-provider |
| `formatMessage` | all 5 | `notify.ts:16-17`, `agent-process.ts:839` | per-provider |
| `splitMessage` | all 5 | `notify.ts:17, :30`, `agent-process.ts` | per-provider |

**Kockázat:** Medium. 25 method body + 6 new class + 1 named interface + 5 const replacement. A D.4 commit biztosítja, hogy a `withTestRunMarking` Form B biztonságosan alkalmazható class instance-ekre.

**Verification gates (D.2 commit):**
- `bun tsc --noEmit` → exit 0
- Lint a `channel-provider.ts`-ra → 34 pre-existing error marad, **0 új**
- `node_modules/.bin/vitest run` (full suite) → 0 failures
- 100% perFile coverage gate (`vitest.config.ts:42-48`) → **fontos: minden új class branch fedett legyen**
  - Az 5 új class metódusainak összesen ~20 új branch-e van (a `implements ChannelProvider` compile-time check biztosítja a signature conformance)
  - Ezeket a tesztek implicit fedik a `getProvider(type)` hívásain keresztül, de közvetlen class-form teszt is kell

**Új teszt szükséges** (per `05 §D.2 Test coverage requirement`):
- `src/__tests__/channel-provider-classes.test.ts` (új fájl):
  - `instanceof ChannelProvider` minden 5 class-ra
  - `provider.type` minden 5-re
  - `validateToken` visszatérési shape (`ValidateTokenResult`)
  - `splitMessage` non-empty array a telegram/slack/discord-ra
  - googlechat/teams: `sendMessage` throws a template-t
  - `UnsupportedDirectSendProvider` öröklési lánc ellenőrzése (GooglechatProvider + TeamsProvider a base-ből származnak)
- A teszt a `withTestRunMarking(new TelegramProvider())` wrap-pert is ellenőrzi (DR2 regression pin)

**Rollback:** A D.2 commit egyben reverting visszaállítja az object literal provider-eket. A D.4 commit NEM revertálódik (a Form B decorator object literal-okon is működik).

---

## Workflow végrehajtás (3 fázis, a user korábbi utasítása szerint)

### Fázis 1: D.4 implementáció (1 worktree-isolated subagent)
- Worktree: `$HOME/claw-d4` (NOT /tmp/, per CLAUDE.md §8)
- Feladat: D.4 commit (`refactor(channel-provider): rewrite withTestRunMarking as explicit-delegation function (D.4)`)
- Verification: tsc, lint, vitest subset
- Jelentés: SHA + gate exit code-ok

### Fázis 2: D.2 implementáció (1 worktree-isolated subagent)
- Worktree: `$HOME/claw-d2` (a D.4 commitra alapozva, de nem a main branch-ből; a subagent kapja meg a D.4 SHA-t)
- Feladat: D.2 commit (`refactor(channel-provider): extract 5 provider classes + UnsupportedDirectSendProvider base (D.2)`) + új teszt fájl
- Verification: tsc, lint, vitest (full suite + coverage)
- Jelentés: SHA + gate exit code-ok

### Fázis 3: Dupla verifikáció (2 parallel subagent, worktree-isolated)
- Verifier X (checklist): commit meta, file:line integrity, byte-identical interface signatures, 100% perFile coverage gate
- Verifier Y (adversarial): D.4 spread removal, D.2 abstract base dedup correctness, bun --bun vitest semantics, mock factory continuity
- Ha bármelyik FAIL/BROKEN: fix → re-verify

### Fázis 4: Merge + /code-review
- D.4 merge --ff-only a `refactor/classbase` branch-re
- D.2 merge --ff-only a `refactor/classbase` branch-re
- Worktree cleanup
- **USER invokes `/code-review max --fix`** (CLAUDE.md §8: skill `disable-model-invocation`, csak user hívhatja manuálisan)

## Verification gates (konkrét számokkal, plan-writing time mérve)

`/Users/eggp/marveen-develop/test-baseline/` worktree, branch `refactor/classbase`, HEAD `bd94d2c` (a G.1 revert) mérésekor:

| Gate | Baseline | Post-D.4 elvárás | Post-D.2 elvárás |
|---|---|---|---|
| `wc -l src/channel-provider.ts` | 551 | 552-555 (+1-4 sor explicit delegation) | 700-740 (+~150 sor 6 class + interface) |
| `node_modules/.bin/eslint src/channel-provider.ts` | 34 errors | **34 errors (változatlan)** | **34 errors (változatlan)** — 0 új |
| `bun tsc --noEmit` (erre a fájlra) | 0 errors | 0 errors | 0 errors |
| `node_modules/.bin/vitest run` | (full suite) | 0 failures | 0 failures + 100% perFile coverage |
| `git show HEAD --stat` files changed | — | 1 (channel-provider.ts) | 2 (channel-provider.ts + új teszt) |
| `markedProviders` has 5 keys | YES | YES (byte-identical) | YES (class instance-ekre mutat) |
| `getProvider` signature | `(ChannelProviderType) => ChannelProvider` | unchanged | unchanged |
| 5 `instanceof TelegramApiError` analog | N/A | N/A | googlechat/teams `sendMessage` throw template (`'<type>: direct dashboard send not supported …'`) |

## Documentált kockázatok (G.4-re, nem G.1-re)

- **D.5 (helper removal):** a `getChannelToken` / `getChannelChatId` / `channelStateDir` / `readChannelToken` / `getProvider` free function-ök maradnak. D.5 (4 sub-phase) külön tervet igényel a jövőben.
- **D.3 (`ChannelProviderRegistry`):** jelenleg szükségtelen (OE-D2: 1-method wrapper for 0-consumer addition). Ha később szükséges (pl. lifecycle methods), külön terv.
- **D.1 (`ChannelEnv` class):** jelenleg a 4 helper free function marad. D.1 külön tervet igényel.
- **D.6 (`LoggerLike` adoption):** conditional on H.1 (LoggerLike interface). Ha H.1 landol, D.6 opcionális `log?` paramétert ad az 5 provider class-hoz.
- **17 test mock:** semmit nem kell változtatni (a `getProvider` szignatúra byte-identical; a mock factory-k továbbra is működnek).
- **18 production importer:** semmit nem kell változtatni (a `getProvider` és a helper függvények byte-identical).

## Következő lépések (D.4+D.2 landolása után)

A D subsystem 4 további fázisa (`D.1 ChannelEnv`, `D.3 ChannelProviderRegistry`, `D.5 helper removal`, `D.6 LoggerLike`) külön tervet igényel. A jelenlegi 2 commit megalapozza a következő fázisokat, mert a class-ok már USED-ek.

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/src/channel-provider.ts` (módosított — D.4 + D.2)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/channel-provider-classes.test.ts` (új — D.2 test addition)
- `/Users/eggp/marveen-develop/test-baseline/vitest.config.ts` (referencia: 100% perFile gate L42-48)
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/d-channel-provider/` (terv forrás, 8 fájl)
