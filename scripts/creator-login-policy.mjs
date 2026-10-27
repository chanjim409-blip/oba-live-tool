/** A login-state export hint only; this does not verify the creator role or grant permission. */
export function isCreatorControlPage(state) {
  if (!state || typeof state.href !== 'string') return false
  let url
  try { url = new URL(state.href) } catch { return false }
  return url.origin === 'https://buyin.jinritemai.com'
    && url.pathname === '/dashboard/live/control'
    && state.hasNameNode === true && state.hasLivePanel === true && state.hasChallenge === false
}
