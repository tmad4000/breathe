// Authorized inline feedback. Remote WIT code loads only after an explicit tap.
(function () {
  const ownScript = document.currentScript;
  function install() {
    const mount = document.querySelector(ownScript?.dataset.mountSelector || '#breathe-feedback-mount');
    if (!mount) return;
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = 'Send feedback'; button.className = 'feedback-link'; mount.append(button);
    button.onclick = () => {
      if (window.WitFeedback?.ready) { window.WitFeedback.open(); return; }
      if (button.disabled) return;
      button.disabled = true; button.textContent = 'Opening feedback…';
      const loader = document.createElement('script');
      loader.src = 'https://worldissuetracker.com/widget/wit-feedback.js'; loader.defer = true;
      Object.assign(loader.dataset, {
        trackerSlug: 'breathe-feedback', app: 'Breathe', mode: 'feedback',
        mountSelector: ownScript?.dataset.mountSelector || '#breathe-feedback-mount',
        trigger: 'tab', label: 'Send feedback', appVersion: ownScript?.dataset.appVersion || ''
      });
      let timer, attempts = 0;
      const failed = () => { clearInterval(timer); loader.remove(); if(!window.WitFeedback?.ready){delete window.WitFeedback;window.__witFeedbackLoading=false;} button.disabled=false; button.textContent='Feedback unavailable · retry'; };
      loader.onerror = failed;
      loader.onload = () => {
        timer = setInterval(() => {
          if (window.WitFeedback?.ready) { clearInterval(timer); button.remove(); window.WitFeedback.open(); }
          else if (++attempts > 100) failed();
        },100);
      };
      document.body.appendChild(loader);
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
