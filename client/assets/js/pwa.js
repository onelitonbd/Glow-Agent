// Glow Agent PWA Install Handling
let deferredPrompt = null;
let installButton = null;

function createInstallButton() {
  // Check if already installed
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    console.log('Glow Agent is already installed as PWA');
    return;
  }

  // Create install button if not exists
  const headerActions = document.querySelector('.header-actions');
  if (!headerActions || document.getElementById('pwaInstallButton')) return;

  const btn = document.createElement('button');
  btn.id = 'pwaInstallButton';
  btn.className = 'icon-button';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Install Glow Agent');
  btn.title = 'Install Glow Agent as app';
  btn.style.display = 'none';
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/></svg>`;
  
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`Glow Agent install prompt outcome: ${outcome}`);
    deferredPrompt = null;
    btn.style.display = 'none';
  });

  // Insert before settings button if possible
  headerActions.insertBefore(btn, headerActions.firstChild);
  installButton = btn;
}

window.addEventListener('beforeinstallprompt', (e) => {
  console.log('Glow Agent: beforeinstallprompt fired - app is installable');
  e.preventDefault();
  deferredPrompt = e;
  if (installButton) {
    installButton.style.display = 'grid';
  } else {
    createInstallButton();
    if (installButton) installButton.style.display = 'grid';
  }
});

window.addEventListener('appinstalled', () => {
  console.log('Glow Agent: PWA was installed');
  deferredPrompt = null;
  if (installButton) installButton.style.display = 'none';
  // Show toast if available
  if (window.showToast) {
    try { window.showToast('Glow Agent installed as app!'); } catch {}
  }
});

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createInstallButton);
} else {
  createInstallButton();
}

// Also listen for display-mode change
window.matchMedia('(display-mode: standalone)').addEventListener?.('change', (e) => {
  if (e.matches) {
    console.log('Glow Agent: Now running as installed PWA');
  }
});
