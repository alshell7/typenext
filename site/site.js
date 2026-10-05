const screenshot = document.getElementById('writing-screenshot')
document.querySelectorAll('[data-theme]').forEach(button => {
  button.addEventListener('click', () => {
    const theme = button.dataset.theme
    screenshot.src = `assets/writing-${theme}.png`
    document.querySelectorAll('[data-theme]').forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)))
  })
})
