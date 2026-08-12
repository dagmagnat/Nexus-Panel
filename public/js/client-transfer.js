(function () {
  'use strict';

  const fileInput = document.getElementById('clientTransferFile');
  const fileInfo = document.getElementById('clientTransferFileInfo');
  const modeSelect = document.getElementById('clientTransferMode');
  const nodeModeSelect = document.getElementById('clientTransferNodeMode');
  const selectedNodesBox = document.getElementById('clientTransferSelectedNodes');
  const dryRunButton = document.getElementById('clientTransferDryRun');
  const importButton = document.getElementById('clientTransferImport');
  const statusBox = document.getElementById('clientTransferStatus');
  const resultBox = document.getElementById('clientTransferResult');
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  if (!fileInput || !modeSelect || !nodeModeSelect || !dryRunButton || !importButton) return;

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return value + ' Б';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' КБ';
    return (value / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  function setStatus(message, kind) {
    statusBox.hidden = !message;
    statusBox.className = 'alert' + (kind ? ' ' + kind : '');
    statusBox.textContent = message || '';
  }

  function setBusy(busy) {
    dryRunButton.disabled = busy;
    importButton.disabled = busy;
    fileInput.disabled = busy;
    modeSelect.disabled = busy;
    nodeModeSelect.disabled = busy;
    document.querySelectorAll('[data-client-transfer-node]').forEach(input => { input.disabled = busy; });
  }

  function selectedNodeIds() {
    return Array.from(document.querySelectorAll('[data-client-transfer-node]:checked'))
      .map(input => Number(input.value))
      .filter(value => Number.isInteger(value) && value > 0);
  }

  function syncNodeMode() {
    const selected = nodeModeSelect.value === 'selected';
    selectedNodesBox.hidden = !selected;
    if (!selected) {
      document.querySelectorAll('[data-client-transfer-node]').forEach(input => { input.checked = false; });
    }
  }

  function formatResult(result) {
    const inspection = result.inspection || result;
    const lines = [];
    lines.push(result.message || (result.dryRun ? 'Проверка завершена без записи' : 'Операция завершена'));
    lines.push('Клиентов в файле: ' + Number(inspection.clients ?? result.inputClients ?? 0));
    if ('created' in result) {
      lines.push('Будет/создано новых: ' + Number(result.created || 0));
      lines.push('Будет/обновлено: ' + Number(result.updated || 0));
      lines.push('Пропущено: ' + Number(result.skipped || 0));
      lines.push('Конфликтов: ' + Number(result.conflictCount || 0));
      lines.push('Связей создано: ' + Number(result.assignmentsCreated || 0));
      lines.push('Связей обновлено: ' + Number(result.assignmentsUpdated || 0));
      lines.push('Связей без подходящего узла: ' + Number(result.unmatchedAssignments || 0));
    } else {
      lines.push('Связей с узлами в файле: ' + Number(inspection.assignments || 0));
    }
    if (result.backupPath) lines.push('Резервная копия: ' + result.backupPath);
    if (Array.isArray(result.conflicts) && result.conflicts.length) {
      lines.push('', 'Конфликты:');
      result.conflicts.forEach(item => lines.push('- ' + (item.login || 'клиент') + ': ' + (item.reason || 'конфликт')));
    }
    if (Array.isArray(result.unmatched) && result.unmatched.length) {
      lines.push('', 'Не сопоставлены узлы:');
      result.unmatched.forEach(item => lines.push('- ' + (item.login || 'клиент') + ' → ' + (item.node || 'узел') + ': ' + (item.reason || 'не найден')));
    }
    if (Array.isArray(inspection.warnings) && inspection.warnings.length) {
      lines.push('', 'Предупреждения:');
      inspection.warnings.forEach(message => lines.push('- ' + message));
    }
    return lines.join('\n');
  }

  async function runImport(dryRun) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      setStatus('Сначала выбери JSON-файл клиентов.', 'error');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus('Файл больше 25 МБ. Используй SSH-команду agg clients import.', 'error');
      return;
    }

    const nodeMode = nodeModeSelect.value;
    const nodeIds = selectedNodeIds();
    if (nodeMode === 'selected' && nodeIds.length === 0) {
      setStatus('Для выбранного режима отметь хотя бы один узел новой панели.', 'error');
      return;
    }
    if (!dryRun && modeSelect.value === 'replace' && !window.confirm('Режим replace может заменить UUID и sub_slug существующих клиентов. Ты проверил dry-run и хочешь продолжить?')) return;
    if (!dryRun && !window.confirm('Импортировать клиентов в локальную базу Nexus Panel? Перед записью будет создана резервная копия.')) return;

    const query = new URLSearchParams({
      mode: modeSelect.value,
      node_mode: nodeMode,
      dry_run: dryRun ? '1' : '0'
    });
    if (nodeIds.length) query.set('target_node_ids', nodeIds.join(','));

    setBusy(true);
    resultBox.hidden = true;
    setStatus(dryRun ? 'Проверяю файл и конфликты без записи…' : 'Импортирую клиентов и создаю резервную копию…', 'ok');
    try {
      const response = await fetch('/clients/transfer/import?' + query.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: file
      });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); }
      catch (_) { throw new Error(text || 'Сервер вернул некорректный ответ'); }
      if (!response.ok || !result.ok) throw new Error(result.error || 'Операция не выполнена');

      resultBox.textContent = formatResult(result);
      resultBox.hidden = false;
      if (dryRun) {
        setStatus('Проверка завершена: база не изменена. Изучи результат и затем нажми «Импортировать».', result.conflictCount ? 'warning' : 'ok');
      } else {
        setStatus('Импорт завершён. Обнови страницу, чтобы увидеть перенесённых клиентов. Удалённые узлы не изменялись.', result.conflictCount ? 'warning' : 'ok');
      }
    } catch (err) {
      setStatus(String(err.message || err), 'error');
    } finally {
      setBusy(false);
      syncNodeMode();
    }
  }

  fileInput.addEventListener('change', function () {
    const file = fileInput.files && fileInput.files[0];
    fileInfo.textContent = file ? file.name + ' · ' + formatBytes(file.size) : 'Файл не выбран';
    resultBox.hidden = true;
    setStatus('', '');
  });
  nodeModeSelect.addEventListener('change', syncNodeMode);
  dryRunButton.addEventListener('click', function () { runImport(true); });
  importButton.addEventListener('click', function () { runImport(false); });
  syncNodeMode();
})();
