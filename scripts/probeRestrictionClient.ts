type StopCode = 'host_platform_restricted' | 'host_login_expired' | 'host_permission_denied' | 'host_rate_limited'
const STOP_CODES: readonly string[] = ['host_platform_restricted', 'host_login_expired', 'host_permission_denied', 'host_rate_limited']

/** Local authenticated host is the sole restriction database writer. Never contact the platform here. */
export class ProbeRestrictionClient {
  private readonly url: string
  constructor(private readonly token: string, port = 9310, private readonly request: typeof fetch = fetch) {
    if (token.length < 32 || /[\r\n]/.test(token) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('host_restriction_gate_unavailable')
    this.url = `http://127.0.0.1:${port}/collector/restriction`
  }
  private async call(method: 'GET' | 'POST', code?: StopCode): Promise<unknown> {
    try {
      const response = await this.request(this.url, { method, headers: { authorization: `Bearer ${this.token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        body: method === 'POST' ? JSON.stringify({ code }) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(2500) })
      if (!response.ok) throw new Error('host_restriction_gate_unavailable')
      return await response.json()
    } catch { throw new Error('host_restriction_gate_unavailable') }
  }
  private parse(raw: unknown): StopCode | null {
    if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'restriction_code')) throw new Error('host_restriction_gate_unavailable')
    const code = (raw as Record<string, unknown>).restriction_code
    if (code === null) return null
    if (typeof code === 'string' && STOP_CODES.includes(code)) return code as StopCode
    throw new Error('host_restriction_gate_unavailable')
  }
  async assertAllowed(): Promise<void> {
    const code = this.parse(await this.call('GET'))
    if (code) throw new Error(code)
  }
  async report(code: string): Promise<void> {
    if (!STOP_CODES.includes(code)) throw new Error('host_restriction_gate_unavailable')
    const written = this.parse(await this.call('POST', code as StopCode))
    // A pre-existing different stop still blocks. Missing or null receipt is not an acknowledgement.
    if (!written) throw new Error('host_restriction_gate_unavailable')
  }
}
