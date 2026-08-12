/**
 * Universal Dirty Form Tracker + Persistent Save Bar
 * Matches the screenshot behavior: shows "Есть несохранённые изменения" + "Сохранить (N)"
 * Works on any page with forms.
 */

(function() {
  let changedFields = new Set();
  let saveBar = null;

  function createSaveBar() {
    if (saveBar) return saveBar;

    saveBar = document.createElement('div');
    saveBar.className = 'save-bar';
    saveBar.innerHTML = `
      <div class="save-info">
        <span>Есть несохранённые изменения</span>
        <span class="save-count">0</span>
      </div>
      <div class="actions" style="display: flex; gap: 10px;">
        <button type="button" class="btn-cancel">Отменить</button>
        <button type="button" class="btn-save">Сохранить</button>
      </div>
    `;

    document.body.appendChild(saveBar);

    // Cancel button
    saveBar.querySelector('.btn-cancel').addEventListener('click', () => {
      if (confirm('Отменить все изменения?')) {
        window.location.reload();
      }
    });

    // Save button - submits the first form on page
    saveBar.querySelector('.btn-save').addEventListener('click', () => {
      const forms = document.querySelectorAll('form');
      if (forms.length > 0) {
        // Mark all dirty fields as touched
        changedFields.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.classList.add('dirty-field');
        });
        
        // Submit the main form (usually the settings or edit form)
        forms[0].submit();
      } else {
        alert('Форма не найдена. Обновите страницу.');
      }
    });

    return saveBar;
  }

  function updateSaveBar() {
    const bar = createSaveBar();
    const countEl = bar.querySelector('.save-count');
    
    countEl.textContent = changedFields.size;

    if (changedFields.size > 0) {
      bar.classList.add('visible');
    } else {
      bar.classList.remove('visible');
    }
  }

  function markDirty(element) {
    if (!element.id) {
      element.id = 'field-' + Math.random().toString(36).substr(2, 9);
    }
    
    if (!changedFields.has(element.id)) {
      changedFields.add(element.id);
      element.classList.add('dirty-field');
      updateSaveBar();
    }
  }

  function initDirtyTracking() {
    // Track all form elements
    const formElements = document.querySelectorAll('input, select, textarea');
    
    formElements.forEach(el => {
      const handler = () => markDirty(el);
      
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      
      // For checkboxes and radios
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.addEventListener('click', handler);
      }
    });

    // Also track initial values for comparison (optional advanced)
    console.log('[DirtyForm] Tracking enabled on', formElements.length, 'fields');
  }

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initDirtyTracking();
      // Show initial bar only if there are forms
      if (document.querySelectorAll('form').length > 0) {
        createSaveBar(); // pre-create but hidden
      }
    });
  } else {
    initDirtyTracking();
    if (document.querySelectorAll('form').length > 0) {
      createSaveBar();
    }
  }

  // Expose for manual control if needed
  window.DirtyForm = {
    reset: () => {
      changedFields.clear();
      document.querySelectorAll('.dirty-field').forEach(el => el.classList.remove('dirty-field'));
      if (saveBar) saveBar.classList.remove('visible');
    },
    forceShow: () => createSaveBar().classList.add('visible')
  };
})();
