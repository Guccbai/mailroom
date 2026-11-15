// Runs before first paint: set html[data-theme] so the page never flashes the
// wrong theme. The app keeps it in sync afterwards (lib.js applyTheme).
;(() => {
  let saved = null
  try {
    saved = localStorage.getItem('mailroom:theme')
  } catch {}
  document.documentElement.dataset.theme =
    saved === 'light' || saved === 'dark'
      ? saved
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
})()
