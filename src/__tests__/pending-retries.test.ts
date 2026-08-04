import { describe, it, expect } from 'vitest'
import {
  shouldSendAlert,
  toPendingRetryView,
  classifyTelegramSendError,
  ALERT_THRESHOLD_MS,
} from '../pending-retries.js'

describe('shouldSendAlert', () => {
  const firstAttempt = 1_000_000
  const threshold = 60 * 60 * 1000 // 1 hour

  it('false amikor nulla ido telt el a firstAttempt ota', () => {
    expect(shouldSendAlert(firstAttempt, firstAttempt, null, threshold)).toBe(false)
  })

  it('false amikor a varakozas meg a threshold alatt van', () => {
    expect(shouldSendAlert(firstAttempt + threshold / 2, firstAttempt, null, threshold)).toBe(false)
  })

  it('false pontosan a threshold-nal (strict >)', () => {
    expect(shouldSendAlert(firstAttempt + threshold, firstAttempt, null, threshold)).toBe(false)
  })

  it('true amikor a varakozas athadja a thresholdot', () => {
    expect(shouldSendAlert(firstAttempt + threshold + 1, firstAttempt, null, threshold)).toBe(true)
  })

  it('false ha mar kuldott riasztast (alertSentAt nem null)', () => {
    expect(
      shouldSendAlert(firstAttempt + 10 * threshold, firstAttempt, firstAttempt + threshold + 1, threshold),
    ).toBe(false)
  })

  it('default threshold = 1 ora ha nincs megadva', () => {
    expect(shouldSendAlert(firstAttempt + ALERT_THRESHOLD_MS + 1, firstAttempt, null)).toBe(true)
    expect(shouldSendAlert(firstAttempt + ALERT_THRESHOLD_MS - 1, firstAttempt, null)).toBe(false)
  })

  it('false ha firstAttempt nulla vagy negativ (korrupt sor)', () => {
    expect(shouldSendAlert(Date.now(), 0, null, threshold)).toBe(false)
    expect(shouldSendAlert(Date.now(), -1, null, threshold)).toBe(false)
  })

  it('false ha now < firstAttempt (orajeles elcsuszass vagy rossz input)', () => {
    expect(shouldSendAlert(firstAttempt - 1000, firstAttempt, null, threshold)).toBe(false)
  })

  it('false nem veges inputokra (NaN)', () => {
    expect(shouldSendAlert(NaN, firstAttempt, null, threshold)).toBe(false)
    expect(shouldSendAlert(firstAttempt + threshold + 1, NaN, null, threshold)).toBe(false)
  })

  it('false ha firstAttempt Infinity (nem veges, de pozitiv)', () => {
    expect(shouldSendAlert(1, Infinity, null, threshold)).toBe(false)
    expect(shouldSendAlert(1, -Infinity, null, threshold)).toBe(false)
  })

  it('false ha now = firstAttempt (most eppen most kerult be)', () => {
    expect(shouldSendAlert(1_000_000, 1_000_000, null, threshold)).toBe(false)
  })

  it('az alertSentAt = 0 ertekkel is false-t ad (a != null loose check miatt)', () => {
    // A kod `alertSentAt != null` loose egyenloseget hasznal, ami `0 != null`
    // -> true-t ad, tehat a 0-at UGY kezeli, mintha lenne stamp. Ez vedő
    // viselkedes egy esetlegesen korrupt sor ellen (epoch 0 stamppel), de
    // a tipus-szignatura (`number | null`) szerint a 0 egy valid szam. A
    // teszt a JELENLEGI viselkedest rogziti.
    expect(shouldSendAlert(firstAttempt + threshold + 1, firstAttempt, 0, threshold)).toBe(false)
  })
})

describe('toPendingRetryView', () => {
  const baseRow = {
    id: 42,
    task_name: 'morning-summary',
    agent_name: 'main',
    first_attempt: 1_000_000,
    last_attempt: 1_000_500,
    attempt_count: 5,
    last_reason: 'busy',
    alert_sent_at: null as number | null,
  }

  it('snake_case DB mezoket camelCase UI view-ra映射sol', () => {
    const view = toPendingRetryView(baseRow, 1_001_000)
    expect(view).toMatchObject({
      id: 42,
      taskName: 'morning-summary',
      agentName: 'main',
      firstAttempt: 1_000_000,
      lastAttempt: 1_000_500,
      attemptCount: 5,
      lastReason: 'busy',
      alertSentAt: null,
    })
  })

  it('ageMs = now - firstAttempt, nulla fele klampelve', () => {
    expect(toPendingRetryView(baseRow, 1_000_000 + 12345).ageMs).toBe(12345)
    // Negativ kor (orajeles elcsuszass): klamp 0-ra
    expect(toPendingRetryView(baseRow, 999_000).ageMs).toBe(0)
  })

  it('ageMs = 0 amikor now pontosan megegyezik firstAttempt-tel', () => {
    expect(toPendingRetryView(baseRow, 1_000_000).ageMs).toBe(0)
  })

  it('alertDue=true a threshold eltelte utan, ha meg nincs riasztva', () => {
    const view = toPendingRetryView(baseRow, 1_000_000 + ALERT_THRESHOLD_MS + 1)
    expect(view.alertDue).toBe(true)
  })

  it('alertDue=false ha mar kuldott riasztast', () => {
    const view = toPendingRetryView(
      { ...baseRow, alert_sent_at: 1_000_000 + ALERT_THRESHOLD_MS + 100 },
      1_000_000 + 2 * ALERT_THRESHOLD_MS,
    )
    expect(view.alertDue).toBe(false)
  })

  it('alertDue=false a window-ban (meg a threshold alatt)', () => {
    const view = toPendingRetryView(baseRow, 1_000_000 + ALERT_THRESHOLD_MS - 1)
    expect(view.alertDue).toBe(false)
  })

  it('egyedi threshold-ot tiszteletben tartja', () => {
    const viewOver = toPendingRetryView(baseRow, 1_000_100, 50)
    expect(viewOver.alertDue).toBe(true)
    const viewUnder = toPendingRetryView(baseRow, 1_000_100, 200)
    expect(viewUnder.alertDue).toBe(false)
  })

  it('default threshold = ALERT_THRESHOLD_MS ha nincs megadva', () => {
    const view = toPendingRetryView(baseRow, 1_000_000 + ALERT_THRESHOLD_MS + 1)
    expect(view.alertDue).toBe(true)
  })

  it('last_reason null mezot is atviszi (UI "ismeretlen ok"-kent mutatja)', () => {
    const view = toPendingRetryView({ ...baseRow, last_reason: null }, 1_001_000)
    expect(view.lastReason).toBeNull()
  })

  it('a view minden kulcsa megegyezik a DB sorral (nincs extra, nincs hianyzo)', () => {
    const view = toPendingRetryView(baseRow, 1_001_000)
    expect(Object.keys(view).sort()).toEqual(
      [
        'agentName',
        'ageMs',
        'alertDue',
        'alertSentAt',
        'attemptCount',
        'firstAttempt',
        'id',
        'lastAttempt',
        'lastReason',
        'taskName',
      ].sort(),
    )
  })
})

describe('classifyTelegramSendError', () => {
  it('a bare network errort (nincs HTTP status) transient-nek tekinti', () => {
    expect(classifyTelegramSendError('fetch failed')).toBe('transient')
    expect(classifyTelegramSendError('TypeError: fetch failed')).toBe('transient')
  })

  it('a 429-et (rate limited) transient-nek tekinti', () => {
    expect(classifyTelegramSendError('Telegram API 429: Too Many Requests')).toBe('transient')
  })

  it('az 5xx-et transient-nek tekinti', () => {
    expect(classifyTelegramSendError('Telegram API 500: Internal Server Error')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 502: Bad Gateway')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 503: Service Unavailable')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 599')).toBe('transient')
  })

  it('a 400-at (rossz chat_id) permanent-nak tekinti', () => {
    expect(classifyTelegramSendError('Telegram API 400: Bad Request: chat not found')).toBe('permanent')
  })

  it('a 401/403/404-et (rossz vagy blokkolt token) permanent-nak tekinti', () => {
    expect(classifyTelegramSendError('Telegram API 401: Unauthorized')).toBe('permanent')
    expect(classifyTelegramSendError('Telegram API 403: Forbidden: bot was blocked by the user')).toBe('permanent')
    expect(classifyTelegramSendError('Telegram API 404: Not Found')).toBe('permanent')
  })

  it('a 4xx-et (429-en kivul) permanent-nak tekinti -- a 408 is', () => {
    // A 408-at normal esetben atmenetinek tekintenenk (timeout), de a kód
    // minden 4xx-et permanent-nak minositi a 429 kivetelevel. Ez egy tudatos
    // dontes: inkabb ne probalkozzon minden tick-ben, mint hogy spam-elje
    // a logot azzal, hogy "ugyanaz a timeout percenkent".
    expect(classifyTelegramSendError('Telegram API 408: Request Timeout')).toBe('permanent')
  })

  // Pinned contract: a függvény VÉDŐÁGA az, amikor a regex kiemel egy statuszt,
  // de az < 400 (1xx/2xx/3xx, kivéve 429). A sendTelegramMessage sosem dobna
  // ilyen uzenetet (mert non-2xx-ra dob hibát), DE ha valaha megvaltozik a
  // hibaformatum vagy egy masik error-wrapper atfogalmazza, ez a fallback
  // garantálja, hogy ne kapjunk 'permanent' besorolast egy sikeres / atirany-
  // itott valaszra. A teszt a JELENLEGI viselkedést rögzíti.
  it('1xx/2xx/3xx statuszokra transient-et ad (vedoag, nem erheto el production-ben)', () => {
    expect(classifyTelegramSendError('Telegram API 200: OK')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 204: No Content')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 301: Moved Permanently')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 302: Found')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 100: Continue')).toBe('transient')
  })

  it('ures stringre transient (nincs match a regex-szel)', () => {
    expect(classifyTelegramSendError('')).toBe('transient')
  })

  it('a statusz-szam utan egy 4. szamjegy nem zavaro (a regex \d{3}\\b-vel stop-pol)', () => {
    // "Telegram API 4299" -- a regex "429"-et fogja kiemelni \b-vel (a 9 utan
    // szamjegy jon, nincs word boundary, tehat a regex NEM match-el). Ilyen-
    // kor a fuggveny 'transient'-et ad vissza (no HTTP status recognized).
    expect(classifyTelegramSendError('Telegram API 4299: weird')).toBe('transient')
  })
})

describe('ALERT_THRESHOLD_MS', () => {
  it('pontosan 1 oranak felel meg (60 perc ms-ben)', () => {
    expect(ALERT_THRESHOLD_MS).toBe(60 * 60 * 1000)
  })
})
