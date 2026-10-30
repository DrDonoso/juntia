// Apply the theme before first paint without requiring an inline CSP exception.
(function () {
  var theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  try {
    var saved = localStorage.getItem('juntia_theme')
    if (saved === 'dark' || saved === 'light') theme = saved
  } catch {
    console.warn('Theme storage is unavailable; using the system preference.')
  }
  document.documentElement.setAttribute('data-theme', theme)
})()
