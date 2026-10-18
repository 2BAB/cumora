/**
 * Contract tests for the BYOA Antigravity (`agy`) adapter.
 *
 * The fake binary implements Antigravity's documented bidirectional NDJSON
 * protocol: one user event on stdin per turn, one cumulative result envelope
 * back. Keeping the fixture cumulative is load-bearing — it catches the most
 * expensive adapter bug: billing prior turns again on every wake.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEngines, getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_TRIAGE_MODEL
  delete process.env.CUMORA_AGY_POST_REPLY_GRACE_MS
  process.env.PATH = ORIGINAL_PATH
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_AGY = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const readline = require('node:readline')
const argv = process.argv.slice(2)
const log = process.env.FAKE_AGY_LOG
if (log) fs.appendFileSync(log, JSON.stringify({ type: 'start', argv, cwd: process.cwd() }) + '\\n')
let turn = 0
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
out({ event: 'init', conversation_id: 'agy-conversation-1', init: { conversation_id: 'agy-conversation-1', model: 'Gemini 3.5 Flash (High)' } })
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  const event = JSON.parse(line)
  const content = event?.message?.content || ''
  if (log) fs.appendFileSync(log, JSON.stringify({ type: 'prompt', event }) + '\\n')
  turn += 1
  // The post-reply summary hop: agy keeps working after the tool result and
  // never emits a terminal result event here, which is exactly the window the
  // daemon bounds once the reply has landed.
  if (process.env.FAKE_AGY_SCENARIO === 'stall') {
    out({ event: 'step_update', step_update: {
      conversation_id: 'agy-conversation-1', step_index: turn, state: 'DONE', step_type: 'agent_response',
      text_delta: 'partial summary',
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 40, total_tokens: 110 },
    } })
    return
  }
  if (process.env.FAKE_AGY_SCENARIO === 'error') {
    out({ event: 'result', result: {
      conversation_id: 'agy-conversation-1', status: 'ERROR', response: '', error: 'quota exhausted',
      duration_seconds: 0.1, num_turns: turn,
      usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10 },
    } })
    return
  }
  // Turn 2 fails before the CLI has anything to account for, so its result
  // envelope omits \`usage\` entirely — the protocol marks the field optional
  // and this is the common way it shows up. Turn 3 goes back to reporting the
  // cumulative session total.
  if (process.env.FAKE_AGY_SCENARIO === 'usage-gap' && turn === 2) {
    out({ event: 'result', result: {
      conversation_id: 'agy-conversation-1', status: 'ERROR', response: '',
      error: 'upstream model unavailable', duration_seconds: 0.1, num_turns: turn,
    } })
    return
  }
  if (process.env.FAKE_AGY_SCENARIO === 'resume-history') {
    // Simulates resuming a conversation that already accumulated 1000 input /
    // 100 output / 400 cache tokens in a previous daemon process.
    const stepUsage = turn === 1
      ? { input_tokens: 50, output_tokens: 8, thinking_tokens: 2, cache_read_tokens: 300, total_tokens: 58 }
      : { input_tokens: 40, output_tokens: 6, thinking_tokens: 1, cache_read_tokens: 350, total_tokens: 46 }
    const cumulative = turn === 1
      ? { input_tokens: 1050, output_tokens: 108, thinking_tokens: 42, cache_read_tokens: 700, total_tokens: 1158 }
      : { input_tokens: 1090, output_tokens: 114, thinking_tokens: 43, cache_read_tokens: 1050, total_tokens: 1204 }
    out({ event: 'step_update', step_update: {
      conversation_id: 'agy-conversation-resumed', step_index: turn * 2 - 1, state: 'ACTIVE', step_type: 'tool',
      tool_name: 'run_command', tool_info: { name: 'run_command' },
    } })
    out({ event: 'step_update', step_update: {
      conversation_id: 'agy-conversation-resumed', step_index: turn * 2 - 1, state: 'DONE', step_type: 'tool',
      tool_name: 'run_command', tool_info: { name: 'run_command' },
    } })
    out({ event: 'step_update', step_update: {
      conversation_id: 'agy-conversation-resumed', step_index: turn * 2, state: 'DONE', step_type: 'agent_response',
      text_delta: 'resumed:' + content, usage: stepUsage,
    } })
    out({ event: 'result', result: {
      conversation_id: 'agy-conversation-resumed', status: 'SUCCESS', response: 'resumed:' + content,
      duration_seconds: turn, num_turns: turn + 5, model: 'Gemini 3.5 Flash (High)', usage: cumulative,
    } })
    return
  }
  out({ event: 'step_update', step_update: {
    conversation_id: 'agy-conversation-1', step_index: turn, state: 'DONE', step_type: 'tool',
    tool_info: { name: 'run_command' },
  } })
  const usage = turn === 1
    ? { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 40, total_tokens: 110 }
    : { input_tokens: 160, output_tokens: 16, thinking_tokens: 7, cache_read_tokens: 70, total_tokens: 176 }
  out({ event: 'result', result: {
    conversation_id: 'agy-conversation-1', status: 'SUCCESS', response: 'echo:' + content,
    duration_seconds: turn, num_turns: turn, model: 'Gemini 3.5 Flash (High)', usage,
  } })
})
`

interface Fixture { root: string; home: string; log: string; env: NodeJS.ProcessEnv }

async function fixture(scenario = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-antigravity-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(binDir)
  await mkdir(home)
  const fake = join(binDir, 'agy')
  await writeFile(fake, FAKE_AGY, 'utf8')
  await chmod(fake, 0o755)
  return {
    root, home, log,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`,
      FAKE_AGY_LOG: log,
      FAKE_AGY_SCENARIO: scenario,
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Wait for a condition the fixture satisfies asynchronously (child boot, the
 *  init event that carries the conversation id). */
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('antigravity persistent session uses auto stream-json without inner --sandbox and bills per-turn deltas', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    model: 'Gemini 3.5 Flash (High)',
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.ok(session)

  const first = await session.send('first prompt')
  const second = await session.send('second prompt')
  await session.stop()

  assert.equal(first.exitCode, 0)
  assert.equal(first.sessionId, 'agy-conversation-1')
  assert.equal(first.model, 'Gemini 3.5 Flash (High)')
  assert.deepEqual(first.usage, {
    input_tokens: 60,
    output_tokens: 10,
    cache_read_input_tokens: 40,
  })
  // The second result is cumulative (160/16/70). Only the 60/6/30 delta is
  // this turn, and cache is a subset of input: 60 - 30 = 30 fresh.
  assert.deepEqual(second.usage, {
    input_tokens: 30,
    output_tokens: 6,
    cache_read_input_tokens: 30,
  })
  assert.equal(hops.length, 2)
  assert.deepEqual(hops[1].usage, second.usage)
  assert.equal(hops[0].toolUses, 1)

  const records = await fakeLog(f)
  const start = records.find((record) => record.type === 'start') as { argv: string[]; cwd: string }
  assert.ok(start.argv.includes('--input-format'))
  assert.ok(start.argv.includes('--output-format'))
  assert.ok(!start.argv.includes('--sandbox'), 'real agent turns must not enable inner --sandbox or cumora IPC outside <home> fails with EPERM')
  assert.ok(start.argv.includes('--dangerously-skip-permissions'))
  assert.equal(start.argv[start.argv.indexOf('--mode') + 1], 'auto')
  assert.ok(!start.argv.includes('first prompt'), 'the prompt must travel on stdin, not argv')
  assert.equal(start.cwd, await realpath(f.home))
  const prompts = records.filter((record) => record.type === 'prompt') as Array<{ event: { event: string; message: { content: string } } }>
  assert.deepEqual(prompts.map((record) => record.event.message.content), ['first prompt', 'second prompt'])
})

test('antigravity resumed session passes --conversation and bills step usage without historical double-charging', { skip: IS_WIN }, async () => {
  const f = await fixture('resume-history')
  const hops: EngineHopReport[] = []
  const logs: string[] = []
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    model: 'Gemini 3.5 Flash (High)',
    resumeSessionId: 'agy-conversation-resumed',
    onLog: (line) => logs.push(line),
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.ok(session)

  const first = await session.send('after restart 1')
  const second = await session.send('after restart 2')
  await session.stop()

  // Turn 1's result.usage is 1050/108/700 (including 1000 historical input
  // tokens from the prior process), but its agent_response step_update carried
  // 50 fresh input / 8 output / 300 cache_read_tokens.
  assert.deepEqual(first.usage, {
    input_tokens: 50,
    output_tokens: 8,
    cache_read_input_tokens: 300,
  })
  assert.deepEqual(second.usage, {
    input_tokens: 40,
    output_tokens: 6,
    cache_read_input_tokens: 350,
  })
  assert.equal(hops.length, 2)
  assert.ok(logs.includes('[antigravity] tool run_command'))
  assert.ok(logs.includes('[antigravity] » resumed:after restart 1'))

  const records = await fakeLog(f)
  const start = records.find((record) => record.type === 'start') as { argv: string[] }
  assert.equal(start.argv[start.argv.indexOf('--conversation') + 1], 'agy-conversation-resumed')
})

test('antigravity keeps its usage baseline across a result that reports no usage', { skip: IS_WIN }, async () => {
  const f = await fixture('usage-gap')
  const hops: EngineHopReport[] = []
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    model: 'Gemini 3.5 Flash (High)',
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.ok(session)

  const first = await session.send('first prompt')
  const second = await session.send('second prompt')
  const third = await session.send('third prompt')
  await session.stop()

  assert.deepEqual(first.usage, { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 40 })

  // Turn 2 failed without reporting usage. Nothing to bill — and, critically,
  // nothing to forget: the 100/10/40 baseline from turn 1 has to survive it.
  assert.equal(second.exitCode, 1)
  assert.match(second.error ?? '', /upstream model unavailable/)
  assert.equal(second.usage, undefined)

  // Turn 3's envelope is the cumulative session total (160/16/70). Only the
  // 60/6/30 delta over turn 1 is new, and cache is a subset of input, so 30
  // tokens are fresh input. Dropping the baseline on turn 2 would bill the
  // whole cumulative counter here — 90/16/70 — charging turn 1 a second time.
  assert.deepEqual(third.usage, { input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 30 })

  // The ledger sees the same two hops and never the phantom third charge.
  assert.equal(hops.length, 2)
  assert.deepEqual(hops.map((hop) => hop.usage), [first.usage, third.usage])
})

test('antigravity classify runs in plan mode with --sandbox and honors CUMORA_TRIAGE_MODEL', { skip: IS_WIN }, async () => {
  const f = await fixture()
  process.env.CUMORA_TRIAGE_MODEL = 'Gemini 3.5 Flash (Low)'
  const result = await getAdapter('antigravity').classify({
    cwd: f.home,
    prompt: 'classify this',
    env: f.env,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.text, 'echo:classify this')
  const records = await fakeLog(f)
  const start = records.find((record) => record.type === 'start') as { argv: string[] }
  assert.ok(start.argv.includes('--sandbox'), 'triage keeps the read-only plan sandbox')
  assert.equal(start.argv[start.argv.indexOf('--mode') + 1], 'plan')
  assert.equal(start.argv[start.argv.indexOf('--model') + 1], 'Gemini 3.5 Flash (Low)')
})

test('antigravity failed result surfaces its reason and still reports spent usage', { skip: IS_WIN }, async () => {
  const f = await fixture('error')
  const result = await getAdapter('antigravity').run({
    home: f.home,
    prompt: 'fail',
    env: f.env,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /quota exhausted/)
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 })
})

test('antigravity seedHome writes AGENTS.md and native workspace skills', { skip: IS_WIN }, async () => {
  const f = await fixture()
  await getAdapter('antigravity').seedHome(f.home, {
    id: 'agy-reviewer', name: 'Aster', role: 'Reviewer', systemPrompt: 'Review independently.',
  })
  const persona = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(persona, /Aster/)
  assert.match(persona, /Review independently/)
  assert.match(persona, /`\.agents\/skills\/` — your skills/)
  assert.ok(existsSync(join(f.home, '.agents', 'skills')))
})

test('antigravity is detected through the agy binary on PATH', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const old = process.env.PATH
  process.env.PATH = f.env.PATH
  try {
    assert.ok((await detectEngines()).includes('antigravity'))
  } finally {
    process.env.PATH = old
  }
})

test('antigravity inlines the standing prompt once, then only the delta rides each wake', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    onLog: () => {},
  })
  assert.ok(session)

  // A fresh process has nothing in its transcript yet, so the daemon must inline
  // the standing prompt (the biggest single source of per-wake context growth).
  assert.equal(session.carriesStandingPrompt, false)
  await session.send('turn 1')
  assert.equal(session.carriesStandingPrompt, true, 'after the inline turn the daemon sends only the per-turn delta')
  await session.send('turn 2')
  assert.equal(session.carriesStandingPrompt, true)
  await session.stop()
})

test('antigravity resumed conversation already carries the standing prompt', { skip: IS_WIN }, async () => {
  const f = await fixture('resume-history')
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    resumeSessionId: 'agy-conversation-resumed',
    onLog: () => {},
  })
  assert.ok(session)
  assert.equal(session.carriesStandingPrompt, true, 'a resumed transcript holds the standing prompt from the prior process')
  await session.stop()
})

test('antigravity ends the post-reply summary hop after the grace and still bills the partial hop', { skip: IS_WIN }, async () => {
  const f = await fixture('stall')
  process.env.CUMORA_AGY_POST_REPLY_GRACE_MS = '20'
  const logs: string[] = []
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    onLog: (line) => logs.push(line),
  })
  assert.ok(session)

  // The fake never emits `result` — agy is still in its summary hop. Once the
  // reply landed, that hop is pure dead time and must not hold the session.
  const turn = session.send('reply then stall')
  // A real reply lands long after agy's init event; wait for the conversation id
  // the session persists so the early end can hand it to the next wake.
  await waitFor(() => session.sessionId !== null)
  session.noteReplyDelivered?.()
  const result = await turn

  assert.equal(result.exitCode, 0, 'an early end is a completed turn, not a failure')
  assert.equal(result.error, undefined)
  assert.equal(result.sessionId, 'agy-conversation-1', 'the conversation id must survive so the next wake resumes it')
  assert.deepEqual(result.usage, { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 40 })
  assert.equal(session.alive, false, 'the stalled process is reaped instead of lingering')
  assert.ok(logs.some((line) => line.includes('reply already delivered')))
  await session.stop({ force: true })
})

test('antigravity answers a ping that lands after the reply by ending the tail immediately', { skip: IS_WIN }, async () => {
  const f = await fixture('stall')
  // Grace 0 disables the timer: only the steer path can finish this turn, which
  // is exactly the behaviour under test.
  process.env.CUMORA_AGY_POST_REPLY_GRACE_MS = '0'
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    onLog: () => {},
  })
  assert.ok(session)

  const turn = session.send('reply then a teammate pings')
  await waitFor(() => session.sessionId !== null)
  session.noteReplyDelivered?.()
  session.steer('a teammate pinged you')
  const result = await turn

  assert.equal(result.exitCode, 0)
  assert.equal(result.sessionId, 'agy-conversation-1')
  assert.equal(session.alive, false, 'the rerun picks the ping up on a resumed conversation')
  await session.stop({ force: true })
})

test('antigravity keeps its tail when no reply landed (steer stays a logged no-op)', { skip: IS_WIN }, async () => {
  const f = await fixture()
  process.env.CUMORA_AGY_POST_REPLY_GRACE_MS = '20'
  const logs: string[] = []
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    onLog: (line) => logs.push(line),
  })
  assert.ok(session)

  const turn = session.send('a turn with no reply tool call')
  session.steer('group noise')
  const result = await turn

  assert.equal(result.exitCode, 0)
  assert.equal(session.alive, true, 'nothing was delivered, so the running turn is left alone')
  assert.ok(logs.some((line) => line.includes('same-turn steer is not supported')))
  await session.stop()
})
