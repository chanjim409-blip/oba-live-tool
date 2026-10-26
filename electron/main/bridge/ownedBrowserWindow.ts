import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Only our dedicated Chrome process may be hidden; never operates unrelated desktop windows. */
export async function ownedBrowserWindows(pid: number, profileDir: string, hide: boolean): Promise<void> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0 || !profileDir) throw new Error('owned_browser_invalid')
  const script = `
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:LA_BROWSER_PID)
$expected=('--user-data-dir='+$env:LA_BROWSER_PROFILE).Replace('\\','/').ToLowerInvariant()
if (-not $p -or $p.Name -ne 'chrome.exe' -or -not $p.CommandLine.Replace('\\','/').ToLowerInvariant().Contains($expected)) { throw 'owned_browser_identity_mismatch' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class OwnedBrowserWindows {
 public delegate bool Visitor(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor v, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static int[] Check(uint target, bool hide) {
  int count=0, visible=0;
  EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h,out owner); if(owner==target){count++; if(hide)ShowWindow(h,0); if(IsWindowVisible(h))visible++;} return true; },IntPtr.Zero);
  return new int[]{count,visible};
 }
}
'@
$result=[OwnedBrowserWindows]::Check([uint32]$env:LA_BROWSER_PID,($env:LA_BROWSER_HIDE -eq '1'))
if($result[0] -lt 1 -or $result[1] -ne 0){throw 'owned_browser_not_hidden'}
Write-Output 'hidden'
`
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 8000,
    env: { ...process.env, LA_BROWSER_PID: String(pid), LA_BROWSER_PROFILE: profileDir, LA_BROWSER_HIDE: hide ? '1' : '0' },
  })
}
