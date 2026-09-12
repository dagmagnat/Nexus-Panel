(function () {
  'use strict';
  if (!document.body.classList.contains('page-settings')) return;
  const bars = [...document.querySelectorAll('.spectrum-pagebar, .spectrum-mobilebar')];
  function updateOffset() {
    const height = Math.max(0, ...bars.map(bar => getComputedStyle(bar).display === 'none' ? 0 : bar.getBoundingClientRect().height));
    document.documentElement.style.setProperty('--settings-header-offset', Math.ceil(height) + 'px');
  }
  updateOffset();
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(updateOffset);
    bars.forEach(bar => observer.observe(bar));
  }
  window.addEventListener('resize', updateOffset, {passive:true});
})();
