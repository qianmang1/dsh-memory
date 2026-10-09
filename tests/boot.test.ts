import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { isMem0Error } from '../src/mem0.ts'
import { checkQueueDir, checkTraceFile, createBootReporter, pingMem0, type BootLine } from '../src/boot.ts'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-boot-'))
  roots.push(dir)
  return dir
}

after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

describe('boot reporter', () => {
  /** Collect what the reporter emitted, keyed by level. */
  function harness(verbose: boolean) {
    const emitted: Array<{ level: string; message: string }> = []
    const traced: BootLine[] = []
    const boot = createBootReporter({
      verbose,
      emit: (level, message) => emitted.push({ level, message }),
      trace: (state, module, detail) => traced.push({ module, state, detail }),
    })
    return { boot, emitted, traced }
  }

  it('formats every module uniformly and traces each line', () => {
    const { boot, emitted, traced } = harness(true)
    boot.report('config', 'ok', 'recall=true')
    boot.report('queue', 'warn', '1 行损坏被忽略')
    boot.report('credentials', 'fail', '缺少 MEM0_API_KEY 凭据')
    boot.finish()

    assert.deepEqual(emitted.map((line) => line.level), ['debug', 'warn', 'error', 'error'])
    assert.match(emitted[0]?.message ?? '', /^dsh-memory \[boot\] config: OK — recall=true$/)
    assert.match(emitted[1]?.message ?? '', /^dsh-memory \[boot\] queue: WARN — 1 行损坏被忽略$/)
    assert.match(emitted[2]?.message ?? '', /^dsh-memory \[boot\] credentials: FAIL — 缺少 MEM0_API_KEY 凭据$/)
    assert.match(emitted[3]?.message ?? '', /自检完成：3 模块（ok=1 warn=1 fail=1 skip=0）$/)
    assert.equal(traced.length, 4)
  })

  it('in quiet mode healthy and skipped modules stay silent; warn and fail still surface', () => {
    const { boot, emitted } = harness(false)
    boot.report('config', 'ok', 'all defaults')
    boot.report('route', 'skip', '无 webServer')
    boot.report('mem0', 'warn', '连通缓慢 2500ms')
    boot.finish()

    assert.deepEqual(emitted.map((line) => line.message.match(/\[boot\] (\w+):/)?.[1]), ['mem0', undefined])
    assert.equal(emitted[0]?.level, 'warn')
    assert.equal(emitted[1]?.level, 'warn', 'the summary speaks when something is wrong')
  })

  it('a healthy quiet boot emits nothing', () => {
    const { boot, emitted } = harness(false)
    boot.report('config', 'ok', 'x')
    boot.report('tools', 'ok', 'y')
    boot.finish()
    assert.equal(emitted.length, 0)
  })

  it('finish is idempotent and lines() exposes the full report', () => {
    const { boot, emitted } = harness(true)
    boot.report('config', 'ok', 'x')
    boot.finish()
    boot.report('mem0', 'ok', 'late arrival must be ignored')
    boot.finish()
    assert.equal(emitted.filter((line) => line.message.includes('自检完成')).length, 1)
    assert.equal(boot.lines().length, 1)
  })
})

describe('queue boot check', () => {
  it('reports an empty queue as ok', async () => {
    const line = await checkQueueDir(join(freshDir(), 'missing'), join(freshDir(), 'missing', 'pending.jsonl'))
    assert.equal(line.state, 'ok')
    assert.match(line.detail, /队列为空/)
  })

  it('counts malformed lines as a warning', async () => {
    const dir = freshDir()
    const jsonl = join(dir, 'pending.jsonl')
    writeFileSync(jsonl, '{"id":"a","text":"完整行","status":"pending"}\n{"torn\n', 'utf8')
    const line = await checkQueueDir(dir, jsonl)
    assert.equal(line.state, 'warn')
    assert.match(line.detail, /1 行损坏被忽略/)
    assert.match(line.detail, /1 待审/)
  })

  it('flags pending backlog above 50 as a warning', async () => {
    const dir = freshDir()
    const jsonl = join(dir, 'pending.jsonl')
    const lines: string[] = []
    for (let i = 0; i < 51; i++) {
      lines.push(JSON.stringify({ id: `id-${i}`, text: `事实 ${i}`, status: 'pending', hash: `h${i}` }))
    }
    writeFileSync(jsonl, `${lines.join('\n')}\n`, 'utf8')
    const line = await checkQueueDir(dir, jsonl)
    assert.equal(line.state, 'warn')
    assert.match(line.detail, /待审积压 51 条/)
  })
})

describe('tracer boot check', () => {
  it('ok when the file does not exist yet (created on first write)', async () => {
    const line = await checkTraceFile(join(freshDir(), 'logs', 'trace.ndjson'))
    assert.equal(line.state, 'ok')
    assert.match(line.detail, /首次写入创建/)
  })

  it('ok when the file already exists (append mode)', async () => {
    const dir = freshDir()
    const file = join(dir, 'trace.ndjson')
    writeFileSync(file, '', 'utf8')
    const line = await checkTraceFile(file)
    assert.equal(line.state, 'ok')
    assert.match(line.detail, /已存在/)
  })
})

describe('mem0 ping', () => {
  const creds = { baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u' }

  it('returns the measured latency on success', async () => {
    const ms = await pingMem0(creds, {
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch,
    })
    assert.equal(typeof ms, 'number')
    assert.ok(ms >= 0)
  })

  it('propagates the classified Mem0Error on auth failure', async () => {
    await assert.rejects(
      () => pingMem0(creds, { fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch }),
      (error: unknown) => isMem0Error(error) && error.kind === 'auth',
    )
  })
})
