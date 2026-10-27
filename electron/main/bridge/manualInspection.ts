import { chromium, type BrowserContext, type Page } from 'playwright'
import { open, readFile, unlink, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RoomBrowserConfig } from './roomBrowserDriver'

/** Fixed labels only; never include browser exceptions, page text, identities or profile paths. */
export type InspectionPhase = 'configuration' | 'profile_resolve' | 'profile_ownership' | 'profile_lease'
  | 'stop_before_launch' | 'browser_launch' | 'stop_after_launch' | 'page_create'
  | 'official_page_navigation' | 'stop_after_navigation' | 'window_foreground'

/** Refuse when OS process ownership cannot be determined; never terminate or attach to a browser. */
export async function assertProfileFree(profile: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('inspection_profile_ownership_unavailable')
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:LA_INSPECTION_PROFILE).TrimEnd([char]92).ToLowerInvariant()
$items = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'"
foreach ($item in $items) {
  if ($null -eq $item.CommandLine) { throw 'profile_ownership_unknown' }
  if ($item.CommandLine -notmatch '(?i)--user-data-dir') {
    # A browser launched without an explicit directory uses the vendor's default directory.
    if ($item.CommandLine -notmatch '(?i)--type=') {
      $default = if ($item.Name -eq 'msedge.exe') { Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data' } else { Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data' }
      if ([IO.Path]::GetFullPath($default).TrimEnd([char]92).ToLowerInvariant() -eq $target) { throw 'profile_in_use' }
    }
    continue
  }
  $whole = [regex]::Match($item.CommandLine, '(?i)"--user-data-dir=([^"]+)"')
  $m = [regex]::Match($item.CommandLine, '(?i)--user-data-dir\s*=\s*(?:"([^"]+)"|(\S+))')
  if ($whole.Success) { $arg = $whole.Groups[1].Value }
  elseif ($m.Success) { $arg = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value } }
  else { throw 'profile_ownership_unknown' }
  $full = [IO.Path]::GetFullPath($arg)
  if ($full.TrimEnd([char]92).ToLowerInvariant() -eq $target) { throw 'profile_in_use' }
  # Unknown aliases may resolve to the target. Refuse rather than assume they are distinct.
  if ($full -match '(?i)~[1-9]') { throw 'profile_ownership_unknown' }
  $dir = [IO.DirectoryInfo]::new($full)
  while ($null -ne $dir) {
    $itemPath = Get-Item -LiteralPath $dir.FullName -Force
    if (($itemPath.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'profile_ownership_unknown' }
    $dir = $dir.Parent
  }
}
`
  try { await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 8000, env: { ...process.env, LA_INSPECTION_PROFILE: profile },
  }) } catch { throw new Error('inspection_profile_busy_or_unavailable') }
}

/** Isolated human-only window. It has no API for send, refresh, role verification or clearing stops. */
export class ManualInspectionWindow {
  private context: BrowserContext | null = null
  private page: Page | null = null
  private lease: FileHandle | null = null
  private leasePath: string | null = null
  private leaseValue = ''
  private state: 'idle' | 'opening' | 'open' | 'closed' | 'failed' = 'idle'
  private failedPhase: InspectionPhase | null = null
  constructor(private readonly config: RoomBrowserConfig,
    private readonly deps: { checkProfile?: (path: string) => Promise<void>; launch?: typeof chromium.launchPersistentContext } = {}) {}

  get status() { return this.state }
  get failureStage(): InspectionPhase | null { return this.failedPhase }

  async open(assertStillStopped: () => void): Promise<void> {
    if (this.state !== 'idle') throw new Error('inspection_already_started')
    this.state = 'opening' // before first await: simultaneous requests cannot both launch
    let phase: InspectionPhase = 'configuration'
    try {
      if (this.config.attachedEndpoint || !this.config.profileDir || !isAbsolute(this.config.profileDir)
        || !this.config.executablePath || !isAbsolute(this.config.executablePath)) throw new Error('inspection_configuration_invalid')
      phase = 'profile_resolve'
      const profile = await realpath(resolve(this.config.profileDir))
      // Avoid symlink aliases which could defeat the OS process-path ownership check.
      if (profile.toLowerCase() !== resolve(this.config.profileDir).toLowerCase()) throw new Error('inspection_profile_alias_unsupported')
      phase = 'profile_ownership'
      await (this.deps.checkProfile ?? assertProfileFree)(profile)
      phase = 'profile_lease'
      this.leasePath = join(profile, '.live-assistant-manual-inspection.lock')
      this.leaseValue = randomUUID()
      this.lease = await open(this.leasePath, 'wx', 0o600)
      await this.lease.writeFile(this.leaseValue)
      await this.lease.sync()
      phase = 'profile_ownership'
      await (this.deps.checkProfile ?? assertProfileFree)(profile)
      phase = 'stop_before_launch'
      assertStillStopped()
      phase = 'browser_launch'
      this.context = await (this.deps.launch ?? chromium.launchPersistentContext)(profile, {
        headless: false, executablePath: this.config.executablePath,
      })
      // Never launch another context or navigate automatically on failures.
      phase = 'stop_after_launch'
      assertStillStopped()
      phase = 'page_create'
      this.page = await this.context.newPage()
      this.context.on('close', () => { if (this.state === 'open') this.state = 'closed' })
      this.state = 'open'
      // The person inspects the account and handles any verification. No room observation or submit.
      phase = 'official_page_navigation'
      await this.page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 12_000 })
      phase = 'stop_after_navigation'
      assertStillStopped()
      phase = 'window_foreground'
      await this.page.bringToFront()
    } catch (error) {
      this.failedPhase = phase
      this.state = 'failed'
      await this.close().catch(() => undefined)
      const code = (error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'inspection_profile_busy_or_unavailable'
        : error instanceof Error && /^inspection_[a-z_]+$/.test(error.message) ? error.message : 'inspection_open_failed'
      throw new Error(code)
    }
  }

  async close(): Promise<void> {
    await this.context?.close()
    this.context = null
    this.page = null
    if (this.lease) { await this.lease.close(); this.lease = null }
    if (this.leasePath) {
      // Do not remove another process's lease. A failed ownership check leaves a stale safe lock.
      try {
        await (this.deps.checkProfile ?? assertProfileFree)(resolve(this.config.profileDir))
        if ((await readFile(this.leasePath, 'utf8')) === this.leaseValue) await unlink(this.leasePath)
      } catch { /* manual recovery after checking no browser holds this profile */ }
    }
    if (this.state !== 'failed') this.state = 'closed'
  }
}
