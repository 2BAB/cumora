/** Contract tests for the BYOA Maka (`maka --acp`) ACP adapter. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const tempDirs: string[] = []
const liveSessions: Array<{ stop(): void | Promise<void> }> = []

const FAKE_MAKA_ACP_SOURCE = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.env.FAKE_MAKA_LOG
const mode = process.env.FAKE_MAKA_MODE || 'ok'
const argv = process.argv.slice(2)
if (argv.length !== 1 || argv[0] !== '--acp') {
  process.stderr.write('maka --acp does not accept extra arguments\n')
  process.exit(2)
}

let prompts = 0
let permissionReply = null
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const record = (entry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  record(msg)
  if (msg.id !== undefined && !msg.method) {
    permissionReply = msg.result
    return
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'maka-sess-fresh', configOptions: [] } })
  } else if (msg.method === 'session/load') {
    if (mode === 'fail-load') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Runtime Host Session was not found.' } })
    } else {
      if (mode === 'replay-on-load') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_REPLAY_TEXT ' } },
          },
        })
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } })
    }
  } else if (msg.method === 'session/set_config_option') {
    if (msg.params?.configId !== 'permission_mode' || !['ask', 'bypass'].includes(msg.params?.value)) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: Invalid Session configuration option' } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } })
    }
  } else if (msg.method === 'session/prompt') {
    prompts += 1
    if (mode === 'die-mid-turn') {
      process.exit(17)
    }
    if (mode === 'session-gone') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Session is not owned by this ACP connection' } })
      return
    }
    if (mode === 'cancelled') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'cancelled' },
      })
      return
    }
    if (mode === 'ask-permission') {
      // Deliberately use id: 1 to verify server->client requests do not collide with client waiters.
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'tc-perm', title: 'Write file' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
    }
    const sid = msg.params.sessionId
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read README.md' } },
    })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong #' + prompts } },
      },
    })
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 110, cachedReadTokens: 30, outputTokens: 15 },
      },
    })
  }
})
`

async function makeFixture(mode = 'ok'): Promise<{
  home: string
  env: NodeJS.ProcessEnv
  readCalls: () => Promise<Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-maka-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const bridge = join(root, 'fake-maka.mjs')
  const logFile = join(root, 'calls.jsonl')
  await writeFile(bridge, FAKE_MAKA_ACP_SOURCE, 'utf8')
  return {
    home,
    env: {
      ...process.env,
      CUMORA_MAKA_BIN: bridge,
      FAKE_MAKA_LOG: logFile,
      FAKE_MAKA_MODE: mode,
    },
    readCalls: async () => {
      const raw = await readFile(logFile, 'utf8').catch(() => '')
      return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
  }
}

afterEach(async () => {
  for (const s of liveSessions.splice(0)) {
    try { await s.stop() } catch { /* already gone */ }
  }
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

test('maka persistent session pins permission_mode=bypass once across wakes and ignores model pin', async () => {
  const f = await makeFixture()
  const logs: string[] = []
  const hops: EngineHopReport[] = []
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    model: 'claude-sonnet-4-6',
    standingPrompt: null,
    resumeSessionId: null,
    onLog: (l) => logs.push(l),
    onHopUsage: (h) => hops.push(h),
  })
  assert.ok(session)
  liveSessions.push(session)

  const r1 = await session.send('first wake')
  const r2 = await session.send('second wake')

  assert.equal(r1.exitCode, 0)
  assert.equal(r2.exitCode, 0)
  assert.equal(r1.sessionId, 'maka-sess-fresh')
  assert.equal(r2.sessionId, 'maka-sess-fresh')
  assert.equal(r1.model, '<maka-default>')
  assert.equal(r1.usage?.input_tokens, 110)
  assert.equal(r1.usage?.output_tokens, 15)
  assert.equal(hops.length, 2)
  assert.equal(hops[0]?.model, '<maka-default>')
  assert.equal(
    logs.filter((l) => l.includes('[maka] model pin (claude-sonnet-4-6) is ignored')).length,
    1,
  )
  assert.ok(logs.some((l) => l.includes('[maka] tool Read README.md')))
  assert.ok(logs.some((l) => l.includes('pong #1')))
  assert.ok(logs.some((l) => l.includes('pong #2')))

  const calls = await f.readCalls()
  assert.deepEqual(
    calls.map((c) => c.method),
    [
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
      'session/prompt',
    ],
  )
  assert.deepEqual(calls[2]?.params, {
    sessionId: 'maka-sess-fresh',
    configId: 'permission_mode',
    value: 'bypass',
  })
  assert.equal(
    calls.some((c) => c.method === 'session/set_config_option' && c.params?.configId === 'model'),
    false,
  )
})

test('maka ignores replayed session/update notifications emitted during session/load', async () => {
  const f = await makeFixture('replay-on-load')
  const logs: string[] = []
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: 'maka-sess-existing',
    onLog: (l) => logs.push(l),
  })
  assert.ok(session)
  liveSessions.push(session)

  const r = await session.send('wake after load')
  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, 'maka-sess-existing')
  assert.ok(!logs.some((l) => l.includes('STALE_REPLAY_TEXT')), 'replayed load chunks must not leak into new turn logs')
  assert.ok(logs.some((l) => l.includes('pong #1')))
})

test('maka auto-answers server-initiated session/request_permission requests without colliding with client waiters', async () => {
  const f = await makeFixture('ask-permission')
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: null,
    onLog: () => {},
  })
  assert.ok(session)
  liveSessions.push(session)

  const r = await session.send('do something requiring permission')
  assert.equal(r.exitCode, 0)

  const calls = await f.readCalls()
  const reply = calls.find((c) => c.id === 1 && !c.method)
  assert.deepEqual(reply?.result, {
    outcome: { outcome: 'selected', optionId: 'allow_always' },
  })
})

test('maka treats stopReason=cancelled as a failed turn instead of success', async () => {
  const f = await makeFixture('cancelled')
  const hops: EngineHopReport[] = []
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: null,
    onLog: () => {},
    onHopUsage: (h) => hops.push(h),
  })
  assert.ok(session)
  liveSessions.push(session)

  const r = await session.send('fail with cancelled stopReason')
  assert.equal(r.exitCode, 1)
  assert.match(r.error ?? '', /cancelled/i)
  assert.equal(hops.length, 0)
})

test('maka self-heals a stale resume at load time and reports a fresh session', async () => {
  const f = await makeFixture('fail-load')
  const logs: string[] = []
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: 'maka-sess-stale',
    onLog: (l) => logs.push(l),
  })
  assert.ok(session)
  liveSessions.push(session)

  const r = await session.send('after stale resume')
  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, 'maka-sess-fresh')
  assert.ok(logs.some((l) => l.includes('session/load failed') && l.includes('fresh session')))

  const calls = await f.readCalls()
  assert.deepEqual(calls.slice(0, 3).map((c) => c.method), ['initialize', 'session/load', 'session/new'])
})

test('maka maps a mid-life missing Runtime Host session to resume-not-found', async () => {
  const f = await makeFixture('session-gone')
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: 'maka-sess-stale',
    onLog: () => {},
  })
  assert.ok(session)
  liveSessions.push(session)

  const r = await session.send('turn on dead backend session')
  assert.equal(r.exitCode, 1)
  assert.equal(r.failure?.kind, 'resume-not-found')
})

test('maka process dying MID-TURN resolves the turn as a failure, never rejects', async () => {
  const f = await makeFixture('die-mid-turn')
  const session = getAdapter('maka').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: null,
    onLog: () => {},
  })
  assert.ok(session)
  liveSessions.push(session)

  const r = await session.send('crash now')
  assert.equal(r.exitCode, 17)
  assert.match(r.error ?? '', /exited with code 17/)
  assert.equal(session.alive, false)
})

test('maka seedHome writes AGENTS.md and .agents/skills, and classify/probe use bypass mode', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('maka')
  await adapter.seedHome(f.home, {
    id: 'agent-maka',
    name: 'Maka Engineer',
    role: 'engineer',
    systemPrompt: 'Follow first principles.',
  })
  const agentsMd = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(agentsMd, /Maka Engineer/)
  assert.match(agentsMd, /\.agents\/skills\//)
  assert.equal((await stat(join(f.home, '.agents', 'skills'))).isDirectory(), true)

  const controller = new AbortController()
  const classified = await adapter.classify({
    cwd: f.home,
    env: f.env,
    prompt: 'Actionable?',
    signal: controller.signal,
  })
  assert.equal(classified.error, undefined)
  assert.equal(classified.text, 'pong #1')

  const calls = await f.readCalls()
  const permCfg = calls.find((c) => c.method === 'session/set_config_option' && c.params?.configId === 'permission_mode')
  assert.equal(permCfg?.params?.value, 'bypass')
})

test('maka probeWake exercises the acp handshake and one-shot run returns text', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('maka')
  const controller = new AbortController()

  const wake = await adapter.probeWake({ cwd: f.home, env: f.env, signal: controller.signal })
  assert.equal(wake.ok, true)

  const oneShot = await adapter.run({
    home: f.home,
    env: f.env,
    prompt: 'say pong',
    signal: controller.signal,
    onLog: () => {},
  })
  assert.equal(oneShot.exitCode, 0)
  assert.equal(oneShot.sessionId, 'maka-sess-fresh')

  const probed = await adapter.probe({ cwd: f.home, env: f.env, tier: 'big', signal: controller.signal })
  assert.equal(probed.text, 'pong #1')
})
