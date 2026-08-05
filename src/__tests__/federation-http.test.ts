// Full coverage for src/web/federation/http.ts.
//
// Bounded body reader for federated peer responses. Refuses overly large
// payloads by inspecting Content-Length up-front (cheap) and by tracking
// the running byte total mid-stream. The module is pure HTTP plumbing --
// no env vars, no fs, no subprocesses, so the temp-sandbox helpers from
// src/__tests__/setup/temp-sandbox.ts are not needed, and the config.ts
// test seams (_setFederationStoreDirForTest / reloadFederationForTest)
// are not used because http.ts does not import config.ts. Response /
// ReadableStream are provided by Node.js's native fetch (undici).

import { describe, it, expect, vi } from 'vitest'
import {
  PeerResponseTooLargeError,
  readBoundedBody,
} from '../web/federation/http.js'

// ---------------------------------------------------------------------------
// PeerResponseTooLargeError
// ---------------------------------------------------------------------------

describe('PeerResponseTooLargeError', () => {
  it('is an Error subclass with the limit embedded in the message', () => {
    const err = new PeerResponseTooLargeError(1024)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PeerResponseTooLargeError)
    expect(err.name).toBe('PeerResponseTooLargeError')
    expect(err.message).toBe('Peer response exceeded 1024 bytes')
  })

  it('survives a throw/catch round-trip (instanceof + message)', () => {
    expect(() => { throw new PeerResponseTooLargeError(0) }).toThrow(PeerResponseTooLargeError)
    try {
      throw new PeerResponseTooLargeError(7)
    } catch (caught) {
      expect((caught as Error).message).toBe('Peer response exceeded 7 bytes')
    }
  })
})

// ---------------------------------------------------------------------------
// readBoundedBody -- body=null fast path
// ---------------------------------------------------------------------------

describe('readBoundedBody -- null body', () => {
  it('returns "" without reading when res.body is null', async () => {
    const res = new Response(null)
    expect(res.body).toBeNull()
    expect(await readBoundedBody(res, 1024)).toBe('')
  })

  it('returns "" when maxBytes=0 and body is null', async () => {
    // No content-length header so the declared check is skipped (parseInt('') = NaN).
    const res = new Response(null)
    expect(res.body).toBeNull()
    expect(await readBoundedBody(res, 0)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// readBoundedBody -- Content-Length pre-check
// ---------------------------------------------------------------------------

describe('readBoundedBody -- Content-Length pre-check', () => {
  it('refuses without reading when declared content-length > maxBytes and cancels the stream', async () => {
    let cancelCalled = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200))
        controller.close()
      },
      cancel() {
        cancelCalled += 1
      },
    })
    const res = new Response(stream, { headers: { 'content-length': '1000' } })
    await expect(readBoundedBody(res, 100)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
    expect(cancelCalled).toBe(1)
  })

  it('swallows a body.cancel error and still throws PeerResponseTooLargeError', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(50))
        controller.close()
      },
      cancel: () => { throw new Error('cancel-failed') },
    })
    const res = new Response(stream, { headers: { 'content-length': '500' } })
    await expect(readBoundedBody(res, 100)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
  })

  it('accepts when declared content-length equals maxBytes exactly (boundary)', async () => {
    const bytes = new Uint8Array(100)
    const res = new Response(bytes, { headers: { 'content-length': '100' } })
    const out = await readBoundedBody(res, 100)
    expect(out.length).toBe(100)
  })

  it('accepts when declared content-length is below maxBytes', async () => {
    const res = new Response('hello', { headers: { 'content-length': '5' } })
    expect(await readBoundedBody(res, 1024)).toBe('hello')
  })

  it('treats a truly missing Content-Length header as unknown and proceeds to read', async () => {
    // ReadableStream bodies have unknown length -- undici does not auto-set
    // content-length. `headers.get('content-length')` returns null here, so
    // the `?? ''` branch fires.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'))
        controller.close()
      },
    })
    const res = new Response(stream)
    expect(res.headers.get('content-length')).toBeNull()
    expect(await readBoundedBody(res, 1024)).toBe('hi')
  })

  it('treats a non-numeric Content-Length as unknown (parses to NaN) and proceeds to read', async () => {
    const res = new Response('hi', { headers: { 'content-length': 'abc' } })
    expect(await readBoundedBody(res, 1024)).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// readBoundedBody -- chunked read
// ---------------------------------------------------------------------------

describe('readBoundedBody -- chunked read', () => {
  it('returns the empty string for an empty stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close() },
    })
    const res = new Response(stream)
    expect(await readBoundedBody(res, 1024)).toBe('')
  })

  it('concatenates multi-chunk UTF-8 bodies', async () => {
    const encoder = new TextEncoder()
    const parts = ['hello ', 'wörld', ' 🌍']
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p))
        controller.close()
      },
    })
    const res = new Response(stream)
    expect(await readBoundedBody(res, 1024)).toBe(parts.join(''))
  })

  it('refuses mid-stream when the running byte total exceeds maxBytes (chunked overflow path)', async () => {
    // Five 40-byte chunks + close (total 200 > maxBytes=100). The third
    // chunk tips total over the cap and the function throws. The cancel
    // DOES propagate to the underlying source here because two chunks are
    // still buffered when overflow is detected (the cancel-when-closed
    // edge case is documented in the dedicated test below).
    let cancelCalled = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40))
        controller.enqueue(new Uint8Array(40))
        controller.enqueue(new Uint8Array(40))
        controller.enqueue(new Uint8Array(40))
        controller.enqueue(new Uint8Array(40))
        controller.close()
      },
      cancel() {
        cancelCalled += 1
      },
    })
    const res = new Response(stream)
    await expect(readBoundedBody(res, 100)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
    expect(cancelCalled).toBe(1)
  })

  it('cancels the reader when overflow is detected mid-stream (mock-reader path)', async () => {
    let cancelCalled = 0
    const fakeReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(60) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(60) })
        // No further reads are needed once the cancel happens.
        .mockResolvedValue({ done: true, value: undefined }),
      cancel: vi.fn(() => {
        cancelCalled += 1
        return Promise.resolve(undefined)
      }),
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close() },
    })
    const res = new Response(stream)
    vi.spyOn(res.body as ReadableStream<Uint8Array>, 'getReader')
      .mockReturnValue(fakeReader as unknown as ReadableStreamDefaultReader<Uint8Array>)
    await expect(readBoundedBody(res, 100)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
    expect(cancelCalled).toBe(1)
  })

  it('refuses a single-chunk payload that exceeds maxBytes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200))
        controller.close()
      },
    })
    const res = new Response(stream)
    await expect(readBoundedBody(res, 100)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
  })

  it('swallows a reader.cancel error and still throws PeerResponseTooLargeError', async () => {
    // Real body stream (two 60-byte chunks; total 120 > maxBytes=100). We
    // mock getReader to return a fake reader whose cancel() throws -- the
    // try/catch around reader.cancel() must swallow it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60))
        controller.enqueue(new Uint8Array(60))
        controller.close()
      },
    })
    const res = new Response(stream)
    const fakeReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(60) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(60) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(() => { throw new Error('reader-cancel-failed') }),
    }
    vi.spyOn(res.body as ReadableStream<Uint8Array>, 'getReader')
      .mockReturnValue(fakeReader as unknown as ReadableStreamDefaultReader<Uint8Array>)
    await expect(readBoundedBody(res, 100)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
    expect(fakeReader.cancel).toHaveBeenCalled()
  })

  it('handles a reader that yields { done: false, value: undefined } (defensive falsy-value branch)', async () => {
    // Defensive: per spec a non-done read must carry a value, but the SUT
    // still has to skip the push and continue looping.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close() },
    })
    const res = new Response(stream)
    const fakeReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: undefined })
        .mockResolvedValueOnce({ done: false, value: undefined })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    vi.spyOn(res.body as ReadableStream<Uint8Array>, 'getReader')
      .mockReturnValue(fakeReader as unknown as ReadableStreamDefaultReader<Uint8Array>)
    expect(await readBoundedBody(res, 1024)).toBe('')
  })

  it('handles an empty Uint8Array chunk (defensive value-truthy still pushes; length 0 -> no overflow)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(new Uint8Array(0))
        controller.close()
      },
    })
    const res = new Response(stream)
    expect(await readBoundedBody(res, 1024)).toBe('')
  })

  it('accepts a payload that ends exactly at maxBytes (boundary)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(50))
        controller.enqueue(new Uint8Array(50))
        controller.close()
      },
    })
    const res = new Response(stream)
    expect((await readBoundedBody(res, 100)).length).toBe(100)
  })
})