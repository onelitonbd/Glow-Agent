(() => {
  const storageKey = 'glow-agent-theme';
  const themes = new Set(['dark', 'light']);

  function storedTheme() {
    try {
      const value = window.localStorage.getItem(storageKey);
      return themes.has(value) ? value : 'dark';
    } catch {
      return 'dark';
    }
  }

  function apply(theme, persist = true) {
    const next = themes.has(theme) ? theme : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    if (persist) {
      try { window.localStorage.setItem(storageKey, next); } catch { /* Theme still applies for this page. */ }
    }
    document.dispatchEvent(new CustomEvent('glow-theme-change', { detail: { theme: next } }));
    return next;
  }

  apply(storedTheme(), false);
  window.GlowTheme = {
    current: () => document.documentElement.dataset.theme || 'dark',
    set: (theme) => apply(theme),
    toggle: () => apply((document.documentElement.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark')
  };
})();
