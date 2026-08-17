import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const H = vi.hoisted(() => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-schedules-'))
  const scheduledTasksDir = path.join(sandbox, 'scheduled-tasks')

  class RequestBodyTooLargeError extends Error {
    readonly limit: number

    constructor(limit: number) {
      super(`Request body exceeded ${limit} bytes`)
      this.name = 'RequestBodyTooLargeError'
      this.limit = limit
    }
  }

  return {
    sandbox,
    scheduledTasksDir,
    maxPromptLength: 20,
    RequestBodyTooLargeError,

    listPendingTaskRetries: vi.fn<() => unknown[]>(() => []),
    deletePendingTaskRetryById: vi.fn<(id: number) => boolean>(() => false),
    listTaskRunHistory: vi.fn<(name: string, limit: number) => unknown[]>(() => []),

    currentBotName: vi.fn<() => string>(() => 'Marveen Test'),
    runAgent: vi.fn<(prompt: string) => Promise<{ text?: string }>>(async () => ({ text: '[]' })),
    loggerInfo: vi.fn<(data: unknown, message: string) => void>(),
    loggerError: vi.fn<(data: unknown, message: string) => void>(),
    toPendingRetryView: vi.fn<(row: unknown, now: number) => unknown>((row, now) => ({ row, now })),
    atomicWriteFileSync: vi.fn<(path: string, content: string) => void>(),
    isValidCronShape: vi.fn<(schedule: string) => boolean>(schedule => schedule.trim().split(/\s+/).length === 5),
    readBody: vi.fn<(req: unknown, opts?: { maxBytes?: number }) => Promise<Buffer>>(async () => Buffer.from('{}')),
    json: vi.fn<(res: unknown, data: unknown, status?: number) => void>(),
    sanitizeScheduleName: vi.fn<(raw: string) => string>(raw => raw.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')),
    safeJoin: vi.fn<(base: string, name: string) => string>((base, name) => path.join(base, name)),
    listAgentNames: vi.fn<() => string[]>(() => []),
    readFileOr: vi.fn<(path: string, fallback: string) => string>((_path, fallback) => fallback),
    listScheduledTasks: vi.fn<() => unknown[]>(() => []),
    writeScheduledTask: vi.fn<(name: string, data: Record<string, unknown>) => void>(),
    runScheduledTaskNow: vi.fn<(name: string) => Promise<{ ok: boolean; error?: string; result?: unknown }>>(async () => ({ ok: true, result: 'done' })),
  }
})

vi.mock('../db.js', () => ({
  listPendingTaskRetries: H.listPendingTaskRetries,
  deletePendingTaskRetryById: H.deletePendingTaskRetryById,
  listTaskRunHistory: H.listTaskRunHistory,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'main-agent',
  currentBotName: H.currentBotName,
}))

vi.mock('../agent.js', () => ({
  runAgent: H.runAgent,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    error: H.loggerError,
  },
}))

vi.mock('../pending-retries.js', () => ({
  toPendingRetryView: H.toPendingRetryView,
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: H.atomicWriteFileSync,
}))

vi.mock('../web/cron.js', () => ({
  isValidCronShape: H.isValidCronShape,
}))

vi.mock('../web/http-helpers.js', () => ({
  readBody: H.readBody,
  json: H.json,
  RequestBodyTooLargeError: H.RequestBodyTooLargeError,
}))

vi.mock('../web/sanitize.js', () => ({
  sanitizeScheduleName: H.sanitizeScheduleName,
  safeJoin: H.safeJoin,
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: H.listAgentNames,
  readFileOr: H.readFileOr,
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: H.scheduledTasksDir,
  MAX_SCHEDULED_TASK_PROMPT_LEN: H.maxPromptLength,
  listScheduledTasks: H.listScheduledTasks,
  writeScheduledTask: H.writeScheduledTask,
}))

vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: H.runScheduledTaskNow,
}))

const { tryHandleSchedules } = await import('../web/routes/schedules.js')

interface CallOptions {
  body?: unknown
  raw?: string
  readError?: Error
}

interface CallResult {
  handled: boolean
  status: number
  body: unknown
}

function makeContext(method: string, fullPath: string): RouteContext {
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const req = new IncomingMessage(new Socket())
  const res = new ServerResponse(req)
  return {
    req,
    res,
    path: url.pathname,
    method,
    url,
  } satisfies RouteContext
}

async function call(method: string, fullPath: string, options: CallOptions = {}): Promise<CallResult> {
  H.json.mockClear()
  H.readBody.mockReset()
  if (options.readError) {
    H.readBody.mockRejectedValue(options.readError)
  } else {
    const raw = options.raw ?? JSON.stringify(options.body ?? {})
    H.readBody.mockResolvedValue(Buffer.from(raw))
  }
  const handled = await tryHandleSchedules(makeContext(method, fullPath))
  const response = H.json.mock.calls.at(-1)
  return {
    handled,
    status: response ? (response[2] ?? 200) : 0,
    body: response?.[1],
  }
}

function scheduleDir(name: string): string {
  const dir = join(H.scheduledTasksDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  rmSync(H.scheduledTasksDir, { recursive: true, force: true })

  H.listPendingTaskRetries.mockReset().mockReturnValue([])
  H.deletePendingTaskRetryById.mockReset().mockReturnValue(false)
  H.listTaskRunHistory.mockReset().mockReturnValue([])
  H.currentBotName.mockReset().mockReturnValue('Marveen Test')
  H.runAgent.mockReset().mockResolvedValue({ text: '[]' })
  H.loggerInfo.mockReset()
  H.loggerError.mockReset()
  H.toPendingRetryView.mockReset().mockImplementation((row, now) => ({ row, now }))
  H.atomicWriteFileSync.mockReset()
  H.isValidCronShape.mockReset().mockImplementation(schedule => schedule.trim().split(/\s+/).length === 5)
  H.readBody.mockReset().mockResolvedValue(Buffer.from('{}'))
  H.json.mockReset()
  H.sanitizeScheduleName.mockReset().mockImplementation(raw => raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, ''))
  H.safeJoin.mockReset().mockImplementation((base, name) => join(base, name))
  H.listAgentNames.mockReset().mockReturnValue([])
  H.readFileOr.mockReset().mockImplementation((_path, fallback) => fallback)
  H.listScheduledTasks.mockReset().mockReturnValue([])
  H.writeScheduledTask.mockReset()
  H.runScheduledTaskNow.mockReset().mockResolvedValue({ ok: true, result: 'done' })
})

afterAll(() => {
  rmSync(H.sandbox, { recursive: true, force: true })
})

describe('dispatcher and schedule agent list', () => {
  it('returns the main agent followed by encoded sub-agent avatars', async () => {
    H.listAgentNames.mockReturnValue(['alpha', 'space name'])

    const result = await call('GET', '/api/schedules/agents')

    expect(result.handled).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body).toEqual([
      { name: 'main-agent', label: 'Marveen Test', avatar: '/api/marveen/avatar' },
      { name: 'alpha', label: 'alpha', avatar: '/api/agents/alpha/avatar' },
      { name: 'space name', label: 'space name', avatar: '/api/agents/space%20name/avatar' },
    ])
  })

  it.each([
    ['POST', '/api/schedules/agents'],
    ['GET', '/api/schedules/expand-questions'],
    ['GET', '/api/schedules/expand-prompt'],
    ['PATCH', '/api/schedules'],
    ['GET', '/api/schedules/example'],
    ['GET', '/api/schedules/example/toggle'],
    ['GET', '/api/schedules/example/run'],
    ['POST', '/api/schedules/pending'],
    ['POST', '/api/schedules/example/runs'],
    ['GET', '/api/schedules/pending/1'],
    ['GET', '/api/unrelated'],
  ])('declines %s %s', async (method, path) => {
    const result = await call(method, path)

    expect(result.handled).toBe(false)
    expect(result.status).toBe(0)
  })
})

describe('POST /api/schedules/expand-questions', () => {
  it.each([
    { body: {}, label: 'missing' },
    { body: { prompt: '   ' }, label: 'blank' },
  ])('rejects a $label prompt', async ({ body }) => {
    const result = await call('POST', '/api/schedules/expand-questions', { body })

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'Prompt is required' })
    expect(H.runAgent).not.toHaveBeenCalled()
  })

  it('extracts a JSON question array from a chatty model response', async () => {
    const questions = [{ question: 'When?', options: ['Now', 'Later'] }]
    H.runAgent.mockResolvedValue({ text: `Here is the result:\n${JSON.stringify(questions)}\nDone.` })

    const result = await call('POST', '/api/schedules/expand-questions', {
      body: { prompt: '  Send report  ', agent: 'researcher' },
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual(questions)
    expect(H.runAgent).toHaveBeenCalledWith(expect.stringContaining('"Send report"'))
    expect(H.runAgent).toHaveBeenCalledWith(expect.stringContaining('Az agens neve: researcher'))
  })

  it('omits the agent sentence when no agent is supplied', async () => {
    const result = await call('POST', '/api/schedules/expand-questions', {
      body: { prompt: 'Task' },
    })

    expect(result.status).toBe(200)
    expect(H.runAgent).toHaveBeenCalledWith(expect.not.stringContaining('Az agens neve:'))
  })

  it.each([
    [{ text: '' }, 'empty response'],
    [{ text: 'no JSON array here' }, 'missing array'],
    [{ text: '[not valid JSON]' }, 'invalid JSON'],
  ])('returns 500 for an %s', async (agentResult) => {
    H.runAgent.mockResolvedValue(agentResult)

    const result = await call('POST', '/api/schedules/expand-questions', {
      body: { prompt: 'Task' },
    })

    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'Failed to generate questions' })
    expect(H.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to generate expand questions',
    )
  })

  it('returns 500 when the agent call rejects', async () => {
    const error = new Error('agent offline')
    H.runAgent.mockRejectedValue(error)

    const result = await call('POST', '/api/schedules/expand-questions', {
      body: { prompt: 'Task' },
    })

    expect(result.status).toBe(500)
    expect(H.loggerError).toHaveBeenCalledWith({ err: error }, 'Failed to generate expand questions')
  })
})

describe('POST /api/schedules/expand-prompt', () => {
  it.each([
    {},
    { prompt: '   ', answers: [] },
  ])('rejects missing or blank prompt', async (body) => {
    const result = await call('POST', '/api/schedules/expand-prompt', { body })

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'Prompt is required' })
  })

  it('expands a prompt with formatted answers', async () => {
    H.runAgent.mockResolvedValue({ text: '  Expanded result  ' })

    const result = await call('POST', '/api/schedules/expand-prompt', {
      body: {
        prompt: '  Brief  ',
        answers: [
          { question: 'When?', answer: 'Today' },
          { question: 'Format?', answer: 'PDF' },
        ],
      },
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ prompt: 'Expanded result' })
    expect(H.runAgent).toHaveBeenCalledWith(expect.stringContaining('Kerdes: When?\nValasz: Today'))
    expect(H.runAgent).toHaveBeenCalledWith(expect.stringContaining('Kerdes: Format?\nValasz: PDF'))
  })

  it('strips a language-tagged code fence', async () => {
    H.runAgent.mockResolvedValue({ text: '```markdown\nExpanded fenced result\n```' })

    const result = await call('POST', '/api/schedules/expand-prompt', {
      body: { prompt: 'Brief', answers: [] },
    })

    expect(result.body).toEqual({ prompt: 'Expanded fenced result' })
  })

  it.each([
    { label: 'empty response', rejects: false },
    { label: 'rejection', rejects: true },
  ])('returns 500 for agent $label', async ({ rejects }) => {
    if (rejects) H.runAgent.mockRejectedValue(new Error('agent offline'))
    else H.runAgent.mockResolvedValue({ text: '' })

    const result = await call('POST', '/api/schedules/expand-prompt', {
      body: { prompt: 'Brief', answers: [] },
    })

    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'Failed to expand prompt' })
    expect(H.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to expand prompt',
    )
  })

  it.each([
    { label: 'omitted answers', body: { prompt: 'Brief' } },
    { label: 'string answers', body: { prompt: 'Brief', answers: 'oops' } },
    { label: 'object answers', body: { prompt: 'Brief', answers: { foo: 'bar' } } },
    { label: 'null answers', body: { prompt: 'Brief', answers: null } },
  ])('rejects $label with 400 and skips agent', async ({ body }) => {
    const result = await call('POST', '/api/schedules/expand-prompt', { body })
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'Answers array is required' })
    expect(H.runAgent).not.toHaveBeenCalled()
  })

  it('accepts an empty answers array and expands without Kerdes blocks', async () => {
    H.runAgent.mockResolvedValue({ text: 'Expanded result' })
    const result = await call('POST', '/api/schedules/expand-prompt', {
      body: { prompt: 'Brief', answers: [] },
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ prompt: 'Expanded result' })
    expect(H.runAgent).toHaveBeenCalledWith(expect.not.stringContaining('Kerdes:'))
  })
})

describe('GET /api/schedules', () => {
  it('returns the scheduled task list', async () => {
    const tasks = [{ name: 'daily' }]
    H.listScheduledTasks.mockReturnValue(tasks)

    const result = await call('GET', '/api/schedules')

    expect(result.status).toBe(200)
    expect(result.body).toEqual(tasks)
  })
})

describe('POST /api/schedules', () => {
  it('returns 413 for an oversized request body', async () => {
    const result = await call('POST', '/api/schedules', {
      readError: new H.RequestBodyTooLargeError(262_144),
    })

    expect(result.status).toBe(413)
    expect(result.body).toEqual({ error: 'Request body too large (max 262144 bytes)' })
    expect(H.readBody).toHaveBeenCalledWith(expect.anything(), { maxBytes: 262_144 })
  })

  it('rethrows non-size request read failures', async () => {
    await expect(call('POST', '/api/schedules', {
      readError: new Error('stream failed'),
    })).rejects.toThrow('stream failed')
  })

  it.each([
    [{ prompt: 'do it', schedule: '* * * * *' }, 'Name is required', 400],
    [{ name: '...', prompt: 'do it', schedule: '* * * * *' }, 'Name is required', 400],
    [{ name: 'task', schedule: '* * * * *' }, 'Prompt is required', 400],
    [{ name: 'task', prompt: '   ', schedule: '* * * * *' }, 'Prompt is required', 400],
    [{ name: 'task', prompt: 'x'.repeat(21), schedule: '* * * * *' }, 'Prompt too large (21 chars, max 20)', 413],
    [{ name: 'task', prompt: 'do it' }, 'Schedule is required', 400],
    [{ name: 'task', prompt: 'do it', schedule: '   ' }, 'Schedule is required', 400],
  ])('validates create payload %#', async (body, error, status) => {
    const result = await call('POST', '/api/schedules', { body })

    expect(result.status).toBe(status)
    expect(result.body).toEqual({ error })
    expect(H.writeScheduledTask).not.toHaveBeenCalled()
  })

  it('rejects an invalid cron expression', async () => {
    H.isValidCronShape.mockReturnValue(false)

    const result = await call('POST', '/api/schedules', {
      body: { name: 'task', prompt: 'do it', schedule: 'bad cron' },
    })

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'Invalid cron expression' })
  })

  it('returns 409 when the sanitized schedule directory already exists', async () => {
    scheduleDir('my-task')

    const result = await call('POST', '/api/schedules', {
      body: { name: 'My Task', prompt: 'do it', schedule: '* * * * *' },
    })

    expect(result.status).toBe(409)
    expect(result.body).toEqual({ error: 'Schedule already exists' })
  })

  it('creates a schedule with every optional field', async () => {
    const result = await call('POST', '/api/schedules', {
      body: {
        name: 'My Task',
        description: 'desc',
        prompt: '  do it  ',
        schedule: '  * * * * *  ',
        agent: 'worker',
        type: 'heartbeat',
        skipIfBusy: true,
        forceSend: true,
        targetSession: 'dedicated',
      },
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, name: 'my-task' })
    expect(H.writeScheduledTask).toHaveBeenCalledWith('my-task', {
      description: 'desc',
      prompt: 'do it',
      schedule: '* * * * *',
      agent: 'worker',
      enabled: true,
      type: 'heartbeat',
      skipIfBusy: true,
      forceSend: true,
      targetSession: 'dedicated',
    })
    expect(H.loggerInfo).toHaveBeenCalledWith(
      { name: 'my-task', schedule: '  * * * * *  ' },
      'Scheduled task created',
    )
  })

  it('applies create defaults for omitted optional fields', async () => {
    const result = await call('POST', '/api/schedules', {
      body: { name: 'plain', prompt: 'do it', schedule: '* * * * *', targetSession: '' },
    })

    expect(result.status).toBe(200)
    expect(H.writeScheduledTask).toHaveBeenCalledWith('plain', {
      description: '',
      prompt: 'do it',
      schedule: '* * * * *',
      agent: 'main-agent',
      enabled: true,
      type: 'task',
      skipIfBusy: false,
      forceSend: false,
      targetSession: undefined,
    })
  })
})

describe('PUT /api/schedules/:name', () => {
  it.each([
    '/api/schedules/%E0%A4%A',
    '/api/schedules/!!!',
  ])('returns 404 for invalid name %s', async (path) => {
    const result = await call('PUT', path, { body: {} })

    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: 'Schedule not found' })
  })

  it('returns 404 when safeJoin rejects the name', async () => {
    H.safeJoin.mockImplementation(() => { throw new Error('escape') })

    const result = await call('PUT', '/api/schedules/task', { body: {} })

    expect(result.status).toBe(404)
  })

  it('returns 404 when the resolved directory is absent', async () => {
    const result = await call('PUT', '/api/schedules/missing', { body: {} })

    expect(result.status).toBe(404)
  })

  it('returns 413 for an oversized update body', async () => {
    scheduleDir('task')

    const result = await call('PUT', '/api/schedules/task', {
      readError: new H.RequestBodyTooLargeError(262_144),
    })

    expect(result.status).toBe(413)
    expect(result.body).toEqual({ error: 'Request body too large (max 262144 bytes)' })
    expect(H.readBody).toHaveBeenCalledWith(expect.anything(), { maxBytes: 262_144 })
  })

  it('rethrows non-size update read failures', async () => {
    scheduleDir('task')

    await expect(call('PUT', '/api/schedules/task', {
      readError: new Error('stream failed'),
    })).rejects.toThrow('stream failed')
  })

  it('rejects an oversized prompt', async () => {
    scheduleDir('task')

    const result = await call('PUT', '/api/schedules/task', {
      body: { prompt: 'x'.repeat(21) },
    })

    expect(result.status).toBe(413)
    expect(result.body).toEqual({ error: 'Prompt too large (21 chars, max 20)' })
  })

  it('rejects an invalid updated cron expression', async () => {
    scheduleDir('task')
    H.isValidCronShape.mockReturnValue(false)

    const result = await call('PUT', '/api/schedules/task', {
      body: { schedule: 'bad cron' },
    })

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'Invalid cron expression' })
  })

  it('updates a decoded and sanitized schedule name', async () => {
    scheduleDir('my-task')
    const data = {
      description: 'new',
      prompt: 'new prompt',
      schedule: '0 9 * * *',
      enabled: false,
    }

    const result = await call('PUT', '/api/schedules/My%20Task', { body: data })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect(H.writeScheduledTask).toHaveBeenCalledWith('my-task', data)
    expect(H.loggerInfo).toHaveBeenCalledWith({ name: 'my-task' }, 'Scheduled task updated')
  })

  it('allows an update with neither prompt nor schedule', async () => {
    scheduleDir('task')

    const result = await call('PUT', '/api/schedules/task', {
      body: { enabled: true },
    })

    expect(result.status).toBe(200)
    expect(H.writeScheduledTask).toHaveBeenCalledWith('task', { enabled: true })
  })
})

describe('DELETE /api/schedules/:name', () => {
  it('returns 404 for an invalid name', async () => {
    const result = await call('DELETE', '/api/schedules/!!!')

    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: 'Schedule not found' })
  })

  it('returns 404 when the directory is absent', async () => {
    const result = await call('DELETE', '/api/schedules/missing')

    expect(result.status).toBe(404)
  })

  it('deletes an existing schedule directory', async () => {
    const dir = scheduleDir('task')

    const result = await call('DELETE', '/api/schedules/task')

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect(existsSync(dir)).toBe(false)
    expect(H.loggerInfo).toHaveBeenCalledWith({ name: 'task' }, 'Scheduled task deleted')
  })
})

describe('POST /api/schedules/:name/toggle', () => {
  it('returns 404 for invalid and missing schedule names', async () => {
    expect((await call('POST', '/api/schedules/!!!/toggle')).status).toBe(404)
    expect((await call('POST', '/api/schedules/missing/toggle')).status).toBe(404)
  })

  it('toggles an enabled schedule off', async () => {
    const dir = scheduleDir('task')
    H.readFileOr.mockReturnValue(JSON.stringify({ enabled: true, keep: 'value' }))

    const result = await call('POST', '/api/schedules/task/toggle')

    expect(result.body).toEqual({ ok: true, enabled: false })
    expect(H.atomicWriteFileSync).toHaveBeenCalledWith(
      join(dir, 'task-config.json'),
      JSON.stringify({ enabled: false, keep: 'value' }, null, 2),
    )
    expect(H.loggerInfo).toHaveBeenCalledWith(
      { name: 'task', enabled: false },
      'Scheduled task toggled',
    )
  })

  it('toggles an explicitly disabled schedule on', async () => {
    scheduleDir('task')
    H.readFileOr.mockReturnValue(JSON.stringify({ enabled: false }))

    const result = await call('POST', '/api/schedules/task/toggle')

    expect(result.body).toEqual({ ok: true, enabled: true })
  })

  it('uses an empty default config when the file is corrupt', async () => {
    scheduleDir('task')
    H.readFileOr.mockReturnValue('not JSON')

    const result = await call('POST', '/api/schedules/task/toggle')

    expect(result.body).toEqual({ ok: true, enabled: false })
    expect(H.atomicWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('task-config.json'),
      JSON.stringify({ enabled: false }, null, 2),
    )
  })
})

describe('POST /api/schedules/:name/run', () => {
  it('returns 404 for invalid and missing schedule names', async () => {
    expect((await call('POST', '/api/schedules/!!!/run')).status).toBe(404)
    expect((await call('POST', '/api/schedules/missing/run')).status).toBe(404)
  })

  it('returns 400 when run-now reports failure', async () => {
    scheduleDir('task')
    H.runScheduledTaskNow.mockResolvedValue({ ok: false, error: 'busy' })

    const result = await call('POST', '/api/schedules/task/run')

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'busy' })
  })

  it('returns a successful run result and logs it', async () => {
    scheduleDir('task')
    H.runScheduledTaskNow.mockResolvedValue({ ok: true, result: { delivered: true } })

    const result = await call('POST', '/api/schedules/task/run')

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, result: { delivered: true } })
    expect(H.loggerInfo).toHaveBeenCalledWith(
      { name: 'task', result: { delivered: true } },
      'Scheduled task run-now fired',
    )
  })
})

describe('pending retries and run history', () => {
  it('maps pending retries with one shared current timestamp', async () => {
    const rows = [{ id: 1 }, { id: 2 }]
    H.listPendingTaskRetries.mockReturnValue(rows)
    H.toPendingRetryView.mockImplementation((row, now) => ({ row, now }))
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456)

    const result = await call('GET', '/api/schedules/pending')
    nowSpy.mockRestore()

    expect(result.status).toBe(200)
    expect(result.body).toEqual([
      { row: rows[0], now: 123_456 },
      { row: rows[1], now: 123_456 },
    ])
    expect(H.toPendingRetryView).toHaveBeenCalledTimes(2)
  })

  it('returns 404 for invalid and missing run-history schedules', async () => {
    expect((await call('GET', '/api/schedules/!!!/runs')).status).toBe(404)
    expect((await call('GET', '/api/schedules/missing/runs')).status).toBe(404)
  })

  it('returns the latest ten run-history rows', async () => {
    scheduleDir('task')
    const runs = [{ id: 3 }]
    H.listTaskRunHistory.mockReturnValue(runs)

    const result = await call('GET', '/api/schedules/task/runs')

    expect(result.status).toBe(200)
    expect(result.body).toEqual(runs)
    expect(H.listTaskRunHistory).toHaveBeenCalledWith('task', 10)
  })

  it('rejects an overflowing numeric pending-retry id', async () => {
    const hugeId = '9'.repeat(400)

    const result = await call('DELETE', `/api/schedules/pending/${hugeId}`)

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'Invalid id' })
    expect(H.deletePendingTaskRetryById).not.toHaveBeenCalled()
  })

  it('returns 404 when the pending retry does not exist', async () => {
    H.deletePendingTaskRetryById.mockReturnValue(false)

    const result = await call('DELETE', '/api/schedules/pending/42')

    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: 'Pending retry not found' })
    expect(H.deletePendingTaskRetryById).toHaveBeenCalledWith(42)
  })

  it('cancels an existing pending retry', async () => {
    H.deletePendingTaskRetryById.mockReturnValue(true)

    const result = await call('DELETE', '/api/schedules/pending/42')

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect(H.loggerInfo).toHaveBeenCalledWith(
      { id: 42 },
      'Pending scheduled-task retry cancelled via API',
    )
  })
})
