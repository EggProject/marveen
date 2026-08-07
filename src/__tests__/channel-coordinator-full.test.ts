import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
const cfg = vi.hoisted(() => { const p = require('node:path') as typeof import('node:path'); const o = require('node:os') as typeof import('node:os'); const root = p.join(o.tmpdir(), `cc-${process.pid}`); return { PROJECT_ROOT: root, STORE_DIR: p.join(root, 'store'), RESPAWN_STAMP_FILE: p.join(root, 'store', '.channel-last-respawn') } })
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), ...cfg }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./channel-coordinator/liveness.js', () => ({ probeNativeChannelDown: vi.fn(() => false) }))
vi.mock('./channel-coordinator/telegram-client.js', () => ({ getUpdates: vi.fn(async () => []), probeHighWater: vi.fn(async () => null), mapUpdate: vi.fn(() => null), TelegramApiError: class extends Error { kind = 'fatal' } }))
vi.mock('./channel-coordinator/ingest.js', () => ({ initIngestDb: vi.fn(), closeIngestDb: vi.fn(), insertIncomingEvent: vi.fn(), createHandoffMessage: vi.fn(), markEventDelivered: vi.fn(), getEventsNeedingHandoff: vi.fn(() => []), getOffset: vi.fn(() => 0), setOffset: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const SRC = join(process.cwd(), 'src', 'channel-coordinator.ts')
describe('channel coordinator helpers', () => {
 it('formats safe handoffs', async () => { const m = await import(SRC); expect(m.neutralizeChannelTags('<channel>x</channel>')).toBe('[stripped-tag]x[stripped-tag]'); expect(m.buildHandoffContent({ kind: 'voice', chat_id: 1, user_id: 2, username: 'u', message_id: 3, content: 'hi', tg_date: 1700000000, meta: { voice: { file_id: 'f' } } })).toContain('attachment_file_id="f"'); expect(m.buildHandoffContent({ kind: 'message', chat_id: null, user_id: null, username: null, message_id: null, content: '', tg_date: null })).toContain('(empty message)') })
 it('covers numeric helpers', async () => { const m = await import(SRC); vi.spyOn(Math, 'random').mockReturnValue(0.5); expect(m.transientBackoffMs(0)).toBe(500); expect(m.transientBackoffMs(20)).toBe(30000); expect(m.inNative409Cooldown(10, 9)).toBe(true); expect(m.inNative409Cooldown(10, 10)).toBe(false) })
 it('uses temporary state', () => { const d = mkdtempSync(join(tmpdir(), 'cc-test-')); expect(d.startsWith(tmpdir())).toBe(true); rmSync(d, { recursive: true, force: true }) })
})
