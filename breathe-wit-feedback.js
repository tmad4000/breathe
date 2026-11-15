// Owner integration: place <span id="breathe-feedback-mount"></span> in settings/footer.
// Load this script with defer. Optional data-mount-selector and data-app-version.
// Feedback is submitted only by the user; no app recordings or telemetry are read.
(function () {
  const ownScript = document.currentScript;
  function install() {
    if (document.querySelector('script[src*="worldissuetracker.com/widget/wit-feedback.js"]')) return;
    const loader = document.createElement('script');
    loader.src = 'https://worldissuetracker.com/widget/wit-feedback.js';
    loader.defer = true;
    Object.assign(loader.dataset, {
      trackerSlug: 'breathe-feedback', app: 'Breathe', mode: 'feedback',
      mountSelector: ownScript?.dataset.mountSelector || '#breathe-feedback-mount',
      trigger: 'tab', label: 'Send feedback',
      appVersion: ownScript?.dataset.appVersion || ''
    });
    document.body.appendChild(loader);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
