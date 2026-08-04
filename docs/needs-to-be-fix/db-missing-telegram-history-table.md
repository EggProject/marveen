# db.ts: telegram_history table is referenced but never created

## Location

`src/db.ts`:

- `saveTelegramMessage` (line 2563) -- `INSERT OR IGNORE INTO telegram_history (...)`
- `getTelegramHistory` (line 2588) -- `SELECT * FROM telegram_history WHERE chat_id = ?`
- `initDatabase` (lines 79-947) -- has `CREATE TABLE IF NOT EXISTS` for 36 tables; **none of them is `telegram_history`**.

## Excerpt

```ts
export function saveTelegramMessage(
  chatId: string,
  messageId: string,
  direction: 'in' | 'out',
  text: string,
  userId?: string,
  ts?: number,
): void {
  const now = ts ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO telegram_history (chat_id, message_id, user_id, direction, text, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, messageId, userId ?? null, direction, text, now)
}
```

```sh
$ grep -n 'CREATE TABLE' src/db.ts | grep -i telegram
# (no match)
```

## Failure scenario

1. Fresh install runs `initDatabase()`. None of the `CREATE TABLE IF NOT EXISTS`
   statements mention `telegram_history`. The table does not exist.
2. Telegram channel ingest path calls `saveTelegramMessage(...)`. better-sqlite3
   throws `SqliteError: no such table: telegram_history`.
3. The caller (the inbound-message capture hook in `settings.json` /
   `web/telegram.ts`) sees an unhandled exception. Depending on caller shape
   it either crashes the Telegram polling loop or silently drops the row.
   In the latter case the conversation-continuity ledger (`conversation_log`)
   still records it, so the dashboard does NOT visibly break -- it is a
   silent data-loss path that only surfaces if someone reads the dashboard log
   for "telegram_history" errors.

Reproduced locally: open a `:memory:` db, call `initDatabase()`, then call
`saveTelegramMessage('c', 'm', 'in', 't')` -- exception fires.

## Pinning test

`src/__tests__/db.test.ts` -- the `telegram history` describe block, the
`saveTelegramMessage writes to telegram_history` and
`getTelegramHistory returns rows for a chat` tests. They will fail until
the table is added to `initDatabase()` (and a corresponding migration for
older installs is provided).

## Suggested direction

Two acceptable resolutions (do BOTH, in order of preference):

1. **Add `CREATE TABLE IF NOT EXISTS telegram_history (...)` in
   `initDatabase()`** between, say, `pending_channel_requests` and
   `task_runs`. Schema per the INSERT statement:
   ```sql
   CREATE TABLE IF NOT EXISTS telegram_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     user_id TEXT,
     direction TEXT NOT NULL CHECK(direction IN ('in','out')),
     text TEXT,
     ts INTEGER NOT NULL,
     UNIQUE(chat_id, message_id, direction)
   )
   CREATE INDEX IF NOT EXISTS idx_telegram_history_chat_ts
     ON telegram_history(chat_id, ts)
   ```
   The existing `INSERT OR IGNORE` enforces the (chat_id, message_id, direction)
   idempotency at write time, but the UNIQUE constraint backs that up at the
   storage layer so a future caller that drops the OR IGNORE still cannot
   double-write.

2. If `telegram_history` is genuinely dead code (left over from a refactor),
   delete both functions instead. The conversation-continuity ledger
   (`conversation_log`) is the active source of truth for inbound/outbound
   messages today.

Until either is done, the test pins the defect.
