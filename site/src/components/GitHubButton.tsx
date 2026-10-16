import { links } from '../content'
import { formatStars, useGitHubStars } from '../hooks/useGitHubStars'
import { GitHubIcon, StarIcon } from './Icons'

export default function GitHubButton({ compact = false }: { compact?: boolean }) {
  const count = useGitHubStars()
  // A count of zero reads as a fallback, not as a number to show off.
  const stars = count && count > 0 ? count : null
  const label = stars === null ? 'View TypeNext on GitHub' : `View TypeNext on GitHub, ${stars} stars`
  if (compact) {
    return (
      <a className="icon-btn icon-btn-wide" href={links.repo} aria-label={label}>
        <GitHubIcon size={17} />
        {stars !== null && <span className="icon-btn-count">{formatStars(stars)}</span>}
      </a>
    )
  }
  return (
    <a className="btn btn-secondary" href={links.repo} aria-label={label}>
      <GitHubIcon size={18} />
      View on GitHub
      <span className="btn-meta" aria-hidden="true">
        <StarIcon size={13} />
        {stars === null ? 'Star' : formatStars(stars)}
      </span>
    </a>
  )
}
