export type Platform = 'mac' | 'windows' | 'linux' | 'mobile' | 'unknown'

type UAData = { platform?: string; mobile?: boolean }

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown'
  const data = (navigator as Navigator & { userAgentData?: UAData }).userAgentData
  const ua = navigator.userAgent
  const hint = `${data?.platform ?? ''} ${ua}`.toLowerCase()
  if (data?.mobile || /android|iphone|ipad|ipod/.test(hint)) return 'mobile'
  // iPadOS reports a Mac user agent; touch points tell them apart.
  if (/mac/.test(hint)) return navigator.maxTouchPoints > 1 ? 'mobile' : 'mac'
  if (/win/.test(hint)) return 'windows'
  if (/linux|x11|cros/.test(hint)) return 'linux'
  return 'unknown'
}

export const platform: Platform = detectPlatform()
export const isApple = platform === 'mac' || /iphone|ipad|mac/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent)
