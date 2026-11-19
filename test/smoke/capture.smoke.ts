/**
 * capture → analyze を実際の Lighthouse と Chrome で通すスモークテスト。
 *
 * 単体テストは保存済みの成果物を相手にするので、Lighthouse を上げたときに
 * 「監査が消えた・成果物の形が変わった」ことに気づけない。ここでは手元に
 * 1st party（127.0.0.1）と 3rd party（localhost）の2つのサーバーを立て、
 * 本物の計測を1回だけ走らせて、各アナライザが読む監査が揃っていること・
 * 主要な数値が取れていることを確かめる。外部ネットワークには出ない。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { analyze } from '../../src/analyze.js'
import { capture } from '../../src/capture/index.js'
import type { Artifacts } from '../../src/core/types.js'

/** アナライザと ablate が lhr から読んでいる監査（src 内の audits[...] 参照と揃える）。 */
const REQUIRED_AUDITS = [
  'metrics',
  'network-requests',
  'total-blocking-time',
  'mainthread-work-breakdown',
  'third-party-summary',
  'third-party-facades',
  'render-blocking-resources',
  'largest-contentful-paint-element',
  'prioritize-lcp-image',
  'critical-request-chains',
]

/** 単色の PNG（LCP 要素にする画像）。 */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function listen(handler: Parameters<typeof createServer>[1], host: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, host, () => resolve(server))
  })
}

const portOf = (s: Server) => (s.address() as AddressInfo).port

describe('capture → analyze（実際の Lighthouse）', () => {
  let firstParty: Server
  let thirdParty: Server
  let outDir: string
  let artifacts: Artifacts
  const image = png(800, 600)

  beforeAll(async () => {
    // 3rd party のタグ: 同期読み込み（レンダリングを止める）＋メインスレッドを 150ms 占有。
    thirdParty = await listen((req, res) => {
      if (req.url?.startsWith('/tag.js')) {
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
        res.end('(function(){var t=Date.now();while(Date.now()-t<150){}window.__tag=1})();')
        return
      }
      res.writeHead(404).end()
    }, 'localhost')

    firstParty = await listen((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>smoke</title>
<link rel="stylesheet" href="/style.css">
<script src="http://localhost:${portOf(thirdParty)}/tag.js"></script>
</head><body><h1>smoke</h1><img src="/hero.png" width="800" height="600" alt="hero"></body></html>`)
        return
      }
      if (req.url === '/style.css') {
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' })
        res.end('body{margin:0;font-family:sans-serif}img{display:block;max-width:100%;height:auto}')
        return
      }
      if (req.url === '/hero.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(image)
        return
      }
      res.writeHead(404).end()
    }, '127.0.0.1')

    outDir = await mkdtemp(path.join(os.tmpdir(), 'tpa-smoke-'))
    const chromeFlags = process.env.CI ? ['--no-sandbox'] : []
    artifacts = await capture(`http://127.0.0.1:${portOf(firstParty)}/`, {
      runs: 1,
      outDir,
      chromeFlags,
      logLevel: 'error',
    })
  }, 180_000)

  afterAll(async () => {
    firstParty?.close()
    thirdParty?.close()
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('trace・devtoolslog・主要な指標が取れている', () => {
    expect(artifacts.meta.lighthouseVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(artifacts.trace.traceEvents.length).toBeGreaterThan(100)
    expect(artifacts.devtoolsLog.length).toBeGreaterThan(10)
    const m = artifacts.meta.metrics
    expect(m.firstContentfulPaint).toBeGreaterThan(0)
    expect(m.largestContentfulPaint).toBeGreaterThan(0)
    expect(m.totalBlockingTime).toBeTypeOf('number')
  })

  it('アナライザが読む Lighthouse の監査がすべて揃っている', () => {
    const audits = Object.keys(artifacts.lhr.audits ?? {})
    const missing = REQUIRED_AUDITS.filter((id) => !audits.includes(id))
    expect(missing).toEqual([])
    const errored = REQUIRED_AUDITS.filter(
      (id) => (artifacts.lhr.audits?.[id] as { scoreDisplayMode?: string } | undefined)?.scoreDisplayMode === 'error',
    )
    expect(errored).toEqual([])
  })

  it('third-party: localhost のタグを 3rd party として数え、CPU を帰属できる', async () => {
    const result = await analyze('third-party', outDir)
    const data = result.data as {
      tags: { count: number; cpuMs: number }
      tagRequests: Array<{ url: string }>
    }
    expect(data.tagRequests.some((r) => r.url.includes('/tag.js'))).toBe(true)
    expect(data.tags.count).toBeGreaterThanOrEqual(1)
    expect(data.tags.cpuMs).toBeGreaterThan(0)
  })

  it('lcp: LCP 要素の画像と各フェーズが取れている', async () => {
    const result = await analyze('lcp', outDir)
    const data = result.data as {
      timeline: { largestContentfulPaintMs?: number }
      lcp: { image?: { url: string }; phases: Array<{ phase: string; ms: number }> }
    }
    expect(data.timeline.largestContentfulPaintMs).toBeGreaterThan(0)
    expect(data.lcp.image?.url).toContain('/hero.png')
    expect(data.lcp.phases.length).toBeGreaterThan(0)
  })

  it('gtm: GTM の無いページでもエラーにならない', async () => {
    const result = await analyze('gtm', outDir, {
      fetch: (() => Promise.reject(new Error('外部への通信はしない'))) as typeof fetch,
    })
    expect(result.analyzer).toBe('gtm')
  })
})
