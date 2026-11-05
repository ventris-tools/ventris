// Sets the colour theme before the page first paints, which is why this is a plain script
// in the head: a module would run too late, and the page would flash the wrong colours.
// Until someone chooses, the theme follows the system. A choice stays in this browser.

(() => {
  const KEY = 'ventris-theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');

  // Some browsers refuse storage. The switch still works then, until the page closes.
  function remembered() {
    try {
      const theme = localStorage.getItem(KEY);
      return ['light', 'dark'].includes(theme) ? theme : null;
    } catch {
      return null;
    }
  }

  function remember(theme) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // The choice lasts as long as the page does.
    }
  }

  let chosen = remembered();

  const opposite = () => (root.dataset.theme === 'dark' ? 'light' : 'dark');

  function labelButtons() {
    const label = `Switch to ${opposite()} mode`;
    for (const button of document.querySelectorAll('.theme-toggle')) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }

  function apply() {
    root.dataset.theme = chosen ?? (system.matches ? 'dark' : 'light');
    labelButtons();
  }

  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', labelButtons);
  document.addEventListener('click', ({ target }) => {
    if (!target.closest('.theme-toggle')) return;
    chosen = opposite();
    remember(chosen);
    apply();
  });
})();
