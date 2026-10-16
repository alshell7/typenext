import ClickSpark from './reactbits/ClickSpark/ClickSpark'
import Magnet from './reactbits/Magnet/Magnet'
import { links } from '../content'
import { useReducedMotion } from '../hooks/useMediaQuery'
import { platform, type Platform } from '../hooks/usePlatform'
import { useTheme } from '../hooks/useTheme'
import { DownloadIcon } from './Icons'

type Offer = { label: string; href: string; detail: string }

export const offers: Record<Platform, Offer> = {
  mac: { label: 'Download for macOS', href: links.releases, detail: 'Apple Silicon and Intel · DMG or ZIP' },
  windows: { label: 'Download for Windows', href: links.releases, detail: 'Setup EXE, MSI or portable ZIP' },
  linux: { label: 'Build for Linux', href: links.development, detail: 'Linux builds from source' },
  mobile: { label: 'Download TypeNext', href: links.releases, detail: 'For Windows and macOS desktops' },
  unknown: { label: 'Download TypeNext', href: links.releases, detail: 'For Windows and macOS' },
}

export const offer = offers[platform]

export default function DownloadButton({ magnetic = true }: { magnetic?: boolean }) {
  const reduced = useReducedMotion()
  const { theme } = useTheme()
  const button = (
    <a className="btn btn-primary btn-download" href={offer.href}>
      <DownloadIcon size={18} />
      {offer.label}
    </a>
  )
  if (reduced || !magnetic) return button
  return (
    <Magnet padding={60} magnetStrength={4} maxOffset={8} wrapperClassName="magnet" scale={1.02}>
      <ClickSpark
        sparkColor={theme === 'dark' ? '#a6b6c8' : '#42644d'}
        sparkCount={8}
        sparkRadius={22}
        sparkSize={8}
        duration={420}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {button}
      </ClickSpark>
    </Magnet>
  )
}
