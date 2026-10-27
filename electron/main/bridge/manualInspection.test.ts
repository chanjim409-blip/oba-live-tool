import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualInspectionWindow } from './manualInspection'

function config(profileDir: string) {
  return { profileDir, executablePath: process.execPath, capturePaths: [], anchorName: 'synthetic',
    expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' }
}

test('manual inspection refuses occupied profiles before launching a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-inspection-'))
  let launched = 0
  const window = new ManualInspectionWindow(config(await realpath(dir)), {
    checkProfile: async () => { throw new Error('inspection_profile_busy_or_unavailable') },
    launch: (async () => { launched++; throw new Error('unexpected') }) as never,
  })
  try {
    await assert.rejects(window.open(() => {}), /inspection_profile_busy_or_unavailable/)
    assert.equal(launched, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('manual inspection uses only one owned profile, no submit, and never reopens implicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-inspection-'))
  const visited: string[] = []; let starts = 0, closes = 0, checks = 0
  const context = { newPage: async () => ({ goto: async (url: string) => { visited.push(url) }, bringToFront: async () => {} }),
    on: () => {}, close: async () => { closes++ } }
  const window = new ManualInspectionWindow(config(await realpath(dir)), { checkProfile: async () => { checks++ },
    launch: (async (_profile: string, options: { headless: boolean }) => { assert.equal(options.headless, false); starts++; return context }) as never })
  try {
    await window.open(() => {})
    assert.deepEqual(visited, ['https://www.douyin.com/user/self'])
    assert.equal(window.status, 'open')
    assert.equal(starts, 1)
    assert.ok(checks >= 2)
    assert.ok((await readFile(join(dir, '.live-assistant-manual-inspection.lock'), 'utf8')).length > 0)
    await assert.rejects(window.open(() => {}), /inspection_already_started/)
    await window.close()
    assert.equal(window.status, 'closed')
    assert.equal(closes, 1)
    await assert.rejects(readFile(join(dir, '.live-assistant-manual-inspection.lock')))
  } finally { await window.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) }
})

test('manual inspection never overwrites an existing profile lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-inspection-'))
  const lease = join(dir, '.live-assistant-manual-inspection.lock')
  await writeFile(lease, 'synthetic-existing-lease')
  let starts = 0
  const window = new ManualInspectionWindow(config(await realpath(dir)), { checkProfile: async () => {},
    launch: (async () => { starts++; throw new Error('unexpected') }) as never })
  try {
    await assert.rejects(window.open(() => {}), /inspection_profile_busy_or_unavailable/)
    assert.equal(starts, 0)
    assert.equal(await readFile(lease, 'utf8'), 'synthetic-existing-lease')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('manual inspection closes its own browser if stop changes while opening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-inspection-'))
  let checks = 0, closes = 0
  const context = { newPage: async () => { throw new Error('should not navigate') }, on: () => {}, close: async () => { closes++ } }
  const window = new ManualInspectionWindow(config(await realpath(dir)), { checkProfile: async () => {}, launch: (async () => context) as never })
  try {
    await assert.rejects(window.open(() => { if (++checks === 2) throw new Error('inspection_stop_changed') }), /inspection_stop_changed/)
    assert.equal(closes, 1)
    assert.equal(window.status, 'failed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
