import assert from 'node:assert/strict'
import { test } from 'node:test'
import { roomFromCapture, parseRoomEvidence } from './roomDiscovery'

test('archive discovery uses public web_rid, never the historical internal room_id', () => {
  const result = roomFromCapture({ anchor_name: 'Synthetic host', web_rid: '123456', room_id: '9999999999999999999' }, 'Synthetic host')
  assert.equal(result.url, 'https://live.douyin.com/123456')
  assert.equal('roomId' in result, false)
  for (const data of [{ anchor_name: 'Other', web_rid: '123456' }, { anchor_name: 'Synthetic host', room_id: '123456' },
    { anchor_name: 'Synthetic host', web_rid: '123456?redirect=other' }]) {
    assert.throws(() => roomFromCapture(data, 'Synthetic host'), /unproven/)
  }
})

const response = (status = 2) => ({ status_code: 0, data: { room_status: 2,
  user: { id_str: '123', nickname: 'Synthetic host' },
  data: [{ id_str: '9999999999999999999', owner_user_id_str: '123', status,
    admin_user_ids: [9999999999999999999], admin_user_ids_str: ['456'] }] } })

test('ended room is not live even when outer room_status is 2; admins use exact strings', () => {
  assert.equal(parseRoomEvidence(response(4)).live, false)
  assert.deepEqual(parseRoomEvidence(response()).adminIds, ['456'])
})

test('room evidence rejects unknown status, owner mismatch and lossy numeric identifiers', () => {
  assert.throws(() => parseRoomEvidence(response(0)), /invalid/)
  const wrong = response(); wrong.data.user.id_str = '789'
  assert.throws(() => parseRoomEvidence(wrong), /invalid/)
  const lossy = response() as any; lossy.data.data[0].id_str = 9999999999999999999
  assert.throws(() => parseRoomEvidence(lossy), /invalid/)
})
