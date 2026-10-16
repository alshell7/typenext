import { useTheme } from '../hooks/useTheme'
import { MoonIcon, SunIcon } from './Icons'

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => setTheme(next)}
      aria-label={`Use ${next} appearance`}
      title={`Use ${next} appearance`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
