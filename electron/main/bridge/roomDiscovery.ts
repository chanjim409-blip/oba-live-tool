import { readFile } from 'node:fs/promises'

/** Recorder metadata is a routing hint, never proof of the current live session or permission. */
export interface DiscoveredRoom {
  url: string
  webRid: string
  anchorName: string
  evidence: 'capture_archive'
}

export function roomFromCapture(raw: unknown, expectedName: string): DiscoveredRoom {
  const data = raw as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || !expectedName.trim()
    || data.anchor_name !== expectedName || typeof data.web_rid !== 'string'
    || !/^\d{1,30}$/.test(data.web_rid)) throw new Error('room_discovery_unproven')
  // room_id is deliberately unused: it refers to the archived broadcast, not the public address.
  return { url: `https://live.douyin.com/${data.web_rid}`, webRid: data.web_rid,
    anchorName: expectedName, evidence: 'capture_archive' }
}

export async function discoverRoom(paths: string[], expectedName: string): Promise<DiscoveredRoom> {
  if (!paths.length || paths.length > 20) throw new Error('room_discovery_paths_invalid')
  const candidates: DiscoveredRoom[] = []
  for (const path of paths) {
    const raw = await readFile(path, 'utf8')
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('room_discovery_file_too_large')
    candidates.push(roomFromCapture(JSON.parse(raw), expectedName))
  }
  if (new Set(candidates.map(item => item.webRid)).size !== 1) throw new Error('room_discovery_ambiguous')
  return candidates[0]
}

export interface RoomEvidence {
  roomId: string
  ownerId: string
  ownerName: string
  live: boolean
  adminIds: string[]
}

/** Observed /webcast/room/web/enter/ response. Outer room_status is NOT the live flag. */
export function parseRoomEvidence(raw: unknown): RoomEvidence {
  const body = raw as { status_code?: unknown; data?: { data?: unknown[]; user?: Record<string, unknown> } }
  const room = body?.data?.data?.[0] as Record<string, unknown> | undefined
  const owner = body?.data?.user
  const numericId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value)
  if (body?.status_code !== 0 || !room || body.data?.data?.length !== 1
    || !numericId(room.id_str) || !numericId(owner?.id_str)
    || (room.owner_user_id_str && owner.id_str !== room.owner_user_id_str) || typeof owner.nickname !== 'string'
    || ![2, 4].includes(room.status as number)) throw new Error('room_evidence_invalid')
  // Numeric JSON IDs may already have lost precision. Only platform string IDs are accepted.
  const admins = room.admin_user_ids_str
  return { roomId: room.id_str, ownerId: owner.id_str, ownerName: owner.nickname,
    live: room.status === 2, adminIds: Array.isArray(admins) ? admins.filter(numericId) : [] }
}
