import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCreatorControlPage } from '../scripts/creator-login-policy.mjs'

const ready = { href: 'https://buyin.jinritemai.com/dashboard/live/control', hasNameNode: true, hasLivePanel: true, hasChallenge: false }

test('only an authenticated-looking exact creator control page is eligible for login-state export', () => {
  assert.equal(isCreatorControlPage(ready), true)
  for (const patch of [
    { href: 'https://www.douyinec.com/' },
    { href: 'https://buyin.jinritemai.com/' },
    { href: 'https://buyin.jinritemai.com/dashboard/live/control/extra' },
    { href: 'https://buyin.jinritemai.com.evil.invalid/dashboard/live/control' },
    { href: 'http://buyin.jinritemai.com/dashboard/live/control' },
    { hasNameNode: false }, { hasLivePanel: false }, { hasChallenge: true }, { hasChallenge: undefined },
  ]) assert.equal(isCreatorControlPage({ ...ready, ...patch }), false)
})
