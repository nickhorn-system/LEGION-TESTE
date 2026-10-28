/* LEGION — painel administrativo
 * admin.js · sessão por cookie, API própria do painel, URL configurável em runtime
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const VIEW_META = {
    dashboard: ['Visão geral', 'Status do sistema em tempo real.'],
    keys: ['Keys', 'Gerencie, revogue e exporte licenças.'],
    generate: ['Gerar keys', 'Criação manual em lote.'],
    validate: ['Validação', 'Teste e integre o endpoint.'],
    settings: ['Configurações', 'URLs, keygen e segurança.'],
    logs: ['Logs', 'Histórico de eventos do sistema.'],
  };

  const STATUS_META = {
    unused: ['Não usada', 'gray'],
    active: ['Ativa', 'green'],
    expired: ['Expirada', 'gold'],
    revoked: ['Revogada', 'red'],
  };

  const LOG_META = {
    generate: ['Key gerada (site)', 'ok'],
    admin_generate: ['Keys geradas (painel)', 'admin'],
    validate_ok: ['Validação OK', 'ok'],
    validate_fail: ['Validação falhou', 'error'],
    admin_login: ['Login admin', 'admin'],
    admin_login_fail: ['Login inválido', 'error'],
    admin_logout: ['Logout', 'info'],
    setting_update: ['Configurações atualizadas', 'admin'],
    key_revoke: ['Key revogada', 'error'],
    key_restore: ['Key reativada', 'ok'],
    key_delete: ['Key excluída', 'error'],
    key_reset: ['HWID liberado', 'admin'],
    key_extend: ['Validade estendida', 'ok'],
    password_change: ['Senha alterada', 'admin'],
    url_check: ['Teste de URL', 'info'],
  };

  const state = {
    cfg: {
      brand: 'LEGION',
      publicUrl: '',
      apiBase: '',
      defaultDurationDays: 30,
      cooldownSeconds: 120,
      maintenance: false,
      models: [],
    },
    keys: { page: 1, pages: 1, search: '', status: 'all', model: 'all', pageSize: 12, total: 0 },
    generated: [],
    codeTab: 'curl',
  };

  /* ---------------------------------------------------------------- utils */

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), delay);
    };
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function relativeTime(iso) {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return '—';
    if (diff < 0) return formatDate(iso);
    if (diff < 60_000) return 'agora';
    if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)} min`;
    if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
    if (diff < 7 * 86_400_000) return `há ${Math.floor(diff / 86_400_000)} d`;
    return formatDate(iso);
  }

  function durationLabel(days) {
    const n = Number(days);
    return n > 0 ? `${n}d` : 'vitalícia';
  }

  function modelLabel(id) {
    const models = Array.isArray(state.cfg.models) ? state.cfg.models : [];
    const model = models.find((item) => item.id === id);
    return model ? model.label : String(id || '—').toUpperCase();
  }

  function toast(message, type = 'info') {
    const root = $('#toastRoot');
    if (!root) return;
    const icons = {
      ok: '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.5 4.5L19 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      error:
        '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.2" fill="currentColor"/><path d="M10.3 3.8 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.8a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
      info: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>',
    };
    const node = document.createElement('div');
    node.className = `toast toast--${type === 'success' ? 'ok' : type === 'error' ? 'error' : 'info'}`;
    node.innerHTML = `<span class="toast__icon">${icons[type === 'success' ? 'ok' : type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
    root.appendChild(node);
    window.setTimeout(() => {
      node.classList.add('is-out');
      window.setTimeout(() => node.remove(), 240);
    }, 3800);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fallback */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- API */

  async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['X-Legion'] = 'panel';
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (response.status === 401 && path !== '/api/admin/login') {
      showLogin();
      const error = new Error('Sessão expirada.');
      error.status = 401;
      throw error;
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.message || data.error || 'Falha na requisição.');
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function apiBase() {
    return String(state.cfg.apiBase || '').replace(/\/+$/, '');
  }

  function endpointUrl() {
    const base = String(state.cfg.publicUrl || state.cfg.apiBase || '').replace(/\/+$/, '');
    if (base) return `${base}/api/validate`;
    return `${window.location.origin}/api/validate`;
  }

  /* ---------------------------------------------------------------- modal */

  let modalResolve = null;

  function confirmModal({ title, text, confirm = 'Confirmar', danger = true }) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      $('#modalTitle').textContent = title;
      $('#modalText').textContent = text;
      $('#modalConfirm').textContent = confirm;
      $('#modalConfirm').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      $('#modal').hidden = false;
    });
  }

  function settleModal(result) {
    if (!modalResolve) return;
    const resolve = modalResolve;
    modalResolve = null;
    $('#modal').hidden = true;
    resolve(result);
  }

  /* ---------------------------------------------------------------- sessão */

  function showLogin() {
    $('#appView').hidden = true;
    $('#loginView').hidden = false;
    $('#loginError').hidden = true;
    $('#loginPassword').value = '';
    closeSidebar();
    window.setTimeout(() => $('#loginPassword').focus(), 60);
  }

  async function enterApp() {
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    await loadSettings(true).catch(() => {});
    setView('dashboard');
  }

  /* ---------------------------------------------------------------- shell */

  function applyShellConfig(settings) {
    state.cfg = { ...state.cfg, ...settings };

    let host = '';
    if (settings.publicUrl) {
      try {
        host = new URL(settings.publicUrl).host;
      } catch {
        host = settings.publicUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      }
    }

    const pillText = $('#urlPillText');
    const pill = $('#urlPill');
    pillText.textContent = host || 'URL não configurada';
    pill.classList.toggle('is-warn', !host);
    pill.classList.toggle('is-off', Boolean(settings.maintenance));

    $('#sidebarUrl').textContent = host || 'URL não configurada';

    const badge = $('#settingsUrlBadge');
    badge.textContent = host ? 'Configurado' : 'Pendente';
    badge.className = `badge ${host ? 'badge--green' : 'badge--gold'}`;

    $('#genDays').value = String(settings.defaultDurationDays ?? 30);

    const endpoint = endpointUrl();
    $('#endpointValue').textContent = endpoint;
    $('#validationUrl').textContent = endpoint;
    $('#endpointHint').textContent = host
      ? 'Endpoint montado a partir da URL pública configurada.'
      : 'Configure a URL pública quando o site estiver online.';
    $('#endpointBadge').textContent = host ? 'Online' : 'Pendente';
    $('#endpointBadge').className = `badge ${host ? 'badge--green' : 'badge--gold'}`;

    renderCodeSample();
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('is-open');
    $('#sidebarOverlay').classList.remove('is-open');
  }

  function openSidebar() {
    $('#sidebar').classList.add('is-open');
    $('#sidebarOverlay').classList.add('is-open');
  }

  function setView(view) {
    if (!VIEW_META[view]) return;
    state.view = view;
    const [title, subtitle] = VIEW_META[view];
    $('#viewTitle').textContent = title;
    $('#viewSub').textContent = subtitle;

    $$('.nav-item[data-view]').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.view === view);
    });
    $$('.view').forEach((section) => {
      section.classList.toggle('is-active', section.id === `view-${view}`);
    });

    closeSidebar();

    if (view === 'dashboard') loadOverview();
    else if (view === 'keys') loadKeys();
    else if (view === 'generate') renderGenerated();
    else if (view === 'validate') {
      $('#validationUrl').textContent = endpointUrl();
      renderCodeSample();
    } else if (view === 'settings') loadSettings(true);
    else if (view === 'logs') loadLogs();
  }

  /* ---------------------------------------------------------------- dashboard */

  async function loadOverview() {
    try {
      const data = await apiFetch('/api/admin/overview');
      const stats = data.stats;

      $('#statTotal').textContent = stats.total;
      $('#statActive').textContent = stats.active;
      $('#statUnused').textContent = stats.unused;
      $('#statToday').textContent = stats.generatedToday;
      $('#statActiveFoot').textContent = stats.total
        ? `${Math.round((stats.active / stats.total) * 100)}% do total`
        : 'em uso agora';
      $('#statTodayFoot').textContent = `${stats.validationsToday} validações hoje`;

      state.cfg = { ...state.cfg, ...data.config };
      applyShellConfig(data.config);
      $('#navKeysCount').textContent = String(stats.total);

      renderModelSummary(stats.byModel || {});
      renderChart(data.chart || []);
      renderBreakdown(stats);
      renderRecent(data.recent || []);
    } catch (error) {
      if (error.status !== 401) toast(error.message, 'error');
    }
  }

  function renderModelSummary(byModel) {
    const root = $('#modelSummary');
    if (!root) return;
    const models = Array.isArray(state.cfg.models) ? state.cfg.models : [];
    root.innerHTML = models
      .map(
        (model) => `<div class="model-summary__item" data-model="${escapeHtml(model.id)}">
          <span class="model-summary__dot"></span>
          <span class="model-summary__name">${escapeHtml(model.label)}</span>
          <span class="model-summary__value">${Number(byModel[model.id] || 0)}</span>
        </div>`,
      )
      .join('');
  }

  function renderChart(chart) {    const root = $('#chart');
    if (!root) return;
    if (!chart.length) {
      root.innerHTML = '<div class="table-empty">Sem dados ainda.</div>';
      return;
    }
    const max = Math.max(1, ...chart.map((day) => day.generated));
    root.innerHTML = chart
      .map((day) => {
        const height = Math.max(4, Math.round((day.generated / max) * 100));
        return `<div class="chart__col" title="${escapeHtml(day.date)} · ${day.generated} key(s)">
          <div class="chart__plot">
            <div class="chart__bar ${day.generated === 0 ? 'is-zero' : ''}" style="height:${height}%">
              <span class="chart__value">${day.generated}</span>
            </div>
          </div>
          <span class="chart__label">${escapeHtml(day.label)}</span>
        </div>`;
      })
      .join('');
  }

  function renderBreakdown(stats) {
    const root = $('#breakdown');
    if (!root) return;
    const rows = [
      ['unused', 'Não usadas', stats.unused],
      ['active', 'Ativas', stats.active],
      ['expired', 'Expiradas', stats.expired],
      ['revoked', 'Revogadas', stats.revoked],
    ];
    const total = Math.max(1, stats.total);
    root.innerHTML = rows
      .map(([key, label, count]) => {
        const pct = Math.round((count / total) * 100);
        return `<div class="breakdown__item">
          <div class="breakdown__head"><span>${label}</span><b>${count} · ${pct}%</b></div>
          <div class="breakdown__track"><div class="breakdown__fill breakdown__fill--${key}" style="width:${pct}%"></div></div>
        </div>`;
      })
      .join('');
  }

  function logMeta(type) {
    return LOG_META[type] || ['Evento', 'info'];
  }

  function renderRecent(items) {
    const root = $('#recentLogs');
    if (!root) return;
    if (!items.length) {
      root.innerHTML = '<li class="table-empty">Nenhum evento registrado ainda.</li>';
      return;
    }
    root.innerHTML = items
      .map((item) => {
        const [label, kind] = logMeta(item.type);
        const icon = kind === 'ok' ? '✓' : kind === 'error' ? '!' : kind === 'admin' ? '→' : '·';
        return `<li>
          <span class="activity__icon activity__icon--${kind}">${icon}</span>
          <span class="activity__text"><b>${escapeHtml(label)}</b><span>${escapeHtml(item.key || item.detail || item.ip || '—')}</span></span>
          <span class="activity__time">${escapeHtml(relativeTime(item.ts))}</span>
        </li>`;
      })
      .join('');
  }

  /* ---------------------------------------------------------------- keys */

  async function loadKeys() {
    const body = $('#keysTableBody');
    body.innerHTML = '<tr><td colspan="7"><div class="table-empty">Carregando...</div></td></tr>';
    try {
      const params = new URLSearchParams({
        page: String(state.keys.page),
        pageSize: String(state.keys.pageSize),
        status: state.keys.status,
        model: state.keys.model,
        search: state.keys.search,
      });
      const data = await apiFetch(`/api/admin/keys?${params.toString()}`);
      state.keys.pages = data.pages;
      state.keys.total = data.total;
      state.keys.page = data.page;

      if (!data.items.length) {
        body.innerHTML = '<tr><td colspan="7"><div class="table-empty">Nenhuma key encontrada.</div></td></tr>';
      } else {
        body.innerHTML = data.items.map(renderKeyRow).join('');
      }

      const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
      const to = Math.min(data.total, data.page * data.pageSize);
      $('#keysCount').textContent = `Mostrando ${from}–${to} de ${data.total} key(s)`;
      renderPager(data);
      $('#navKeysCount').textContent = String(data.total);
    } catch (error) {
      if (error.status !== 401) {
        body.innerHTML = `<tr><td colspan="7"><div class="table-empty">${escapeHtml(error.message)}</div></td></tr>`;
      }
    }
  }

  function renderKeyRow(item) {
    const [statusLabel, statusKind] = STATUS_META[item.status] || ['—', 'gray'];
    const hwid = item.hwid ? escapeHtml(item.hwid) : '—';
    const hwidTitle = item.hwid ? escapeHtml(item.hwid) : '';
    const revokeLabel = item.revoked ? 'Reativar' : 'Revogar';
    const revokeAction = item.revoked ? 'restore' : 'revoke';

    return `<tr>
      <td>
        <div class="cell-key">
          <span>${escapeHtml(item.key)}</span>
          <button class="icon-btn" data-action="copy" data-key="${escapeHtml(item.key)}" title="Copiar key" type="button">
            <svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M15 5.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h.5" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
        </div>
      </td>
      <td><span class="badge badge--${statusKind}">${statusLabel}</span></td>
      <td><span class="cell-mono">${durationLabel(item.durationDays)}</span></td>
      <td><span class="cell-hwid" title="${hwidTitle}">${hwid}</span></td>
      <td><span class="cell-mono">${escapeHtml(formatDate(item.createdAt))}</span></td>
      <td><span class="cell-mono">${item.lastCheckAt ? escapeHtml(relativeTime(item.lastCheckAt)) : '—'}</span></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-action="${revokeAction}" data-key="${escapeHtml(item.key)}" title="${revokeLabel}" type="button">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7.5 6.2a7 7 0 1 0 9 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <button class="icon-btn" data-action="reset" data-key="${escapeHtml(item.key)}" title="Liberar HWID" type="button">
            <svg viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-2.3-5.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M20 4v4.5h-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn" data-action="delete" data-key="${escapeHtml(item.key)}" title="Excluir" type="button">
            <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }

  function renderPager(data) {
    const root = $('#keysPager');
    if (!root) return;
    if (data.pages <= 1) {
      root.innerHTML = '';
      return;
    }
    const pages = [];
    const start = Math.max(1, data.page - 2);
    const end = Math.min(data.pages, data.page + 2);
    for (let page = start; page <= end; page += 1) pages.push(page);

    root.innerHTML = [
      `<button class="pager__btn" data-page="${data.page - 1}" ${data.page === 1 ? 'disabled' : ''} type="button">‹</button>`,
      ...pages.map(
        (page) =>
          `<button class="pager__btn ${page === data.page ? 'is-active' : ''}" data-page="${page}" type="button">${page}</button>`,
      ),
      `<button class="pager__btn" data-page="${data.page + 1}" ${data.page === data.pages ? 'disabled' : ''} type="button">›</button>`,
    ].join('');
  }

  async function keyAction(action, key) {
    if (action === 'copy') {
      const ok = await copyText(key);
      toast(ok ? 'Key copiada.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
      return;
    }

    if (action === 'revoke') {
      await apiFetch('/api/admin/keys/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'revoke', key }),
      });
      toast('Key revogada.', 'success');
    } else if (action === 'restore') {
      await apiFetch('/api/admin/keys/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'restore', key }),
      });
      toast('Key reativada.', 'success');
    } else if (action === 'reset') {
      const ok = await confirmModal({
        title: 'Liberar HWID',
        text: 'A key voltará a ficar disponível para ativação em outro dispositivo e o período será reiniciado a partir do próximo uso.',
        confirm: 'Liberar',
        danger: false,
      });
      if (!ok) return;
      await apiFetch('/api/admin/keys/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'reset', key }),
      });
      toast('HWID liberado.', 'success');
    } else if (action === 'delete') {
      const ok = await confirmModal({
        title: 'Excluir key',
        text: `A key ${key} será removida permanentemente. Essa ação não pode ser desfeita.`,
        confirm: 'Excluir',
      });
      if (!ok) return;
      await apiFetch('/api/admin/keys/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', key }),
      });
      toast('Key excluída.', 'success');
    }

    loadKeys();
    loadOverview();
  }

  /* ---------------------------------------------------------------- gerar */

  async function generateKeys(event) {
    event.preventDefault();
    const button = $('#genSubmit');
    const amount = Number.parseInt($('#genAmount').value, 10) || 1;
    const durationDays = Number.parseInt($('#genDays').value, 10) || 0;
    const note = $('#genNote').value.trim();
    const model = $('#genModel').value;

    button.disabled = true;
    button.textContent = 'Gerando...';
    try {
      const data = await apiFetch('/api/admin/keys', {
        method: 'POST',
        body: JSON.stringify({ model, amount, durationDays, note }),
      });
      state.generated = [
        ...data.keys.map((key) => ({ key, durationDays: data.durationDays, model: data.model })),
        ...state.generated,
      ].slice(0, 100);
      renderGenerated();
      $('#genNote').value = '';
      toast(`${data.keys.length} key(s) ${modelLabel(data.model)} gerada(s).`, 'success');
      loadOverview();
    } catch (error) {
      if (error.status !== 401) toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Gerar agora';
    }
  }

  function renderGenerated() {
    const root = $('#genResult');
    if (!root) return;
    if (!state.generated.length) {
      root.innerHTML = '<li class="empty">Nenhuma key gerada ainda.</li>';
      $('#copyAllBtn').disabled = true;
      return;
    }
    root.innerHTML = state.generated
      .map(
        (item) => `<li>
          <span class="key-list__key">${escapeHtml(item.key)}</span>
          <span class="key-list__meta">${escapeHtml(modelLabel(item.model))} · ${durationLabel(item.durationDays)}</span>
          <button class="icon-btn" data-copy-key="${escapeHtml(item.key)}" title="Copiar" type="button">
            <svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M15 5.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h.5" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
        </li>`,
      )
      .join('');
    $('#copyAllBtn').disabled = false;
  }

  /* ---------------------------------------------------------------- validação */

  async function testValidation(event) {
    event.preventDefault();
    const key = $('#valKey').value.trim();
    const hwid = $('#valHwid').value.trim();
    const result = $('#valResult');

    if (!key) {
      result.textContent = 'Informe uma key.';
      return;
    }

    result.textContent = 'Consultando...';
    try {
      const response = await fetch(`${apiBase()}/api/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, hwid }),
      });
      const data = await response.json();
      result.textContent = JSON.stringify(data, null, 2);
      result.classList.toggle('is-ok', Boolean(data.valid));
      result.classList.toggle('is-error', !data.valid);
    } catch (error) {
      result.textContent = `Falha na chamada: ${error.message}`;
      result.classList.remove('is-ok');
      result.classList.add('is-error');
    }
  }

  function codeSamples() {
    const url = endpointUrl();
    const key = 'INTERNAL-X7K9-P2QM';
    return {
      curl: `curl -X POST "${url}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"${key}","hwid":"SEU-HWID"}'`,
      js: `const response = await fetch("${url}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    key: "${key}",
    hwid: "SEU-HWID",
  }),
});

const result = await response.json();

if (result.valid) {
  console.log("Acesso liberado até", result.expiresAt);
} else {
  console.log("Acesso negado:", result.code);
}`,
      cs: `using System.Net.Http;
using System.Text;
using System.Text.Json;

using var http = new HttpClient();

var payload = JsonSerializer.Serialize(new {
    key = "${key}",
    hwid = "SEU-HWID"
});

var content = new StringContent(payload, Encoding.UTF8, "application/json");
var response = await http.PostAsync("${url}", content);
var json = await response.Content.ReadAsStringAsync();

Console.WriteLine(json);`,
      py: `import requests

response = requests.post(
    "${url}",
    json={"key": "${key}", "hwid": "SEU-HWID"},
    timeout=10,
)

data = response.json()

if data.get("valid"):
    print("Acesso liberado até", data.get("expiresAt"))
else:
    print("Acesso negado:", data.get("code"))`,
    };
  }

  function renderCodeSample() {
    const sample = codeSamples()[state.codeTab] || codeSamples().curl;
    $('#codeSample').textContent = sample;
  }

  /* ---------------------------------------------------------------- settings */

  async function loadSettings(populate) {
    const data = await apiFetch('/api/admin/settings');
    const settings = data.settings;
    applyShellConfig(settings);

    if (populate) {
      $('#setPublicUrl').value = settings.publicUrl || '';
      $('#setApiBase').value = settings.apiBase || '';
      $('#setCooldown').value = String(settings.cooldownSeconds ?? 120);
      $('#setDailyLimit').value = String(settings.dailyLimit ?? 5);
      $('#setDuration').value = String(settings.defaultDurationDays ?? 30);
      $('#setMaintenance').checked = Boolean(settings.maintenance);

      const models = Array.isArray(settings.models) ? settings.models : [];
      const enabled = (id) => {
        const model = models.find((item) => item.id === id);
        return !model || model.enabled !== false;
      };
      $('#modelPrivate').checked = enabled('private');
      $('#modelHeadtrick').checked = enabled('headtrick');
      $('#modelInternal').checked = enabled('internal');
    }
    return settings;
  }

  async function saveSettings(event) {
    event.preventDefault();
    const button = $('#saveSettings');
    const stateLabel = $('#saveState');

    const payload = {
      publicUrl: $('#setPublicUrl').value.trim(),
      apiBase: $('#setApiBase').value.trim(),
      cooldownSeconds: Number.parseInt($('#setCooldown').value, 10) || 0,
      dailyLimit: Number.parseInt($('#setDailyLimit').value, 10) || 0,
      defaultDurationDays: Number.parseInt($('#setDuration').value, 10) || 0,
      maintenance: $('#setMaintenance').checked,
      models: {
        private: { enabled: $('#modelPrivate').checked },
        headtrick: { enabled: $('#modelHeadtrick').checked },
        internal: { enabled: $('#modelInternal').checked },
      },
    };

    button.disabled = true;
    stateLabel.textContent = 'Salvando...';
    stateLabel.classList.remove('is-ok', 'is-error');

    try {
      const data = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      applyShellConfig(data.settings);
      stateLabel.textContent = 'Alterações salvas.';
      stateLabel.classList.add('is-ok');
      toast('Configurações salvas.', 'success');
    } catch (error) {
      if (error.status !== 401) {
        stateLabel.textContent = error.message;
        stateLabel.classList.add('is-error');
        toast(error.message, 'error');
      }
    } finally {
      button.disabled = false;
    }
  }

  async function testUrl() {
    const button = $('#testUrlBtn');
    const target = $('#setPublicUrl').value.trim() || $('#setApiBase').value.trim();
    const output = $('#urlTestResult');

    if (!target) {
      output.textContent = 'Preencha a URL pública primeiro.';
      output.className = 'test-result is-error';
      return;
    }

    button.disabled = true;
    output.textContent = 'Testando...';
    output.className = 'test-result';

    try {
      const response = await fetch('/api/admin/check-url', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Legion': 'panel' },
        body: JSON.stringify({ url: target }),
      });
      const data = await response.json();
      if (data.ok) {
        output.textContent = `Online · HTTP ${data.status} · ${data.latencyMs}ms`;
        output.className = 'test-result is-ok';
      } else {
        output.textContent = `Sem resposta${data.status ? ` · HTTP ${data.status}` : ''}`;
        output.className = 'test-result is-error';
      }
    } catch (error) {
      output.textContent = `Falha: ${error.message}`;
      output.className = 'test-result is-error';
    } finally {
      button.disabled = false;
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    const current = $('#pwCurrent').value;
    const next = $('#pwNext').value;
    const confirm = $('#pwConfirm').value;

    if (next.length < 8) return toast('A nova senha precisa ter 8+ caracteres.', 'error');
    if (next !== confirm) return toast('As senhas não coincidem.', 'error');

    try {
      await apiFetch('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ current, next }),
      });
      $('#pwCurrent').value = '';
      $('#pwNext').value = '';
      $('#pwConfirm').value = '';
      toast('Senha atualizada.', 'success');
    } catch (error) {
      if (error.status !== 401) toast(error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- logs */

  async function loadLogs() {
    const body = $('#logsBody');
    body.innerHTML = '<tr><td colspan="5"><div class="table-empty">Carregando...</div></td></tr>';
    try {
      const type = $('#logsFilter').value;
      const data = await apiFetch(`/api/admin/logs?limit=200&type=${encodeURIComponent(type)}`);
      if (!data.items.length) {
        body.innerHTML = '<tr><td colspan="5"><div class="table-empty">Nenhum evento encontrado.</div></td></tr>';
      } else {
        body.innerHTML = data.items
          .map((item) => {
            const [label, kind] = logMeta(item.type);
            return `<tr>
              <td><span class="cell-mono">${escapeHtml(formatDate(item.ts))}</span></td>
              <td><span class="badge badge--${kind === 'ok' ? 'green' : kind === 'error' ? 'red' : kind === 'admin' ? 'gold' : 'blue'}">${escapeHtml(label)}</span></td>
              <td><span class="cell-mono">${escapeHtml(item.key || '—')}</span></td>
              <td><span class="cell-mono">${escapeHtml(item.ip || '—')}</span></td>
              <td><span class="cell-mono">${escapeHtml(item.detail || '—')}</span></td>
            </tr>`;
          })
          .join('');
      }
      $('#logsCount').textContent = `${data.items.length} evento(s)`;
    } catch (error) {
      if (error.status !== 401) {
        body.innerHTML = `<tr><td colspan="5"><div class="table-empty">${escapeHtml(error.message)}</div></td></tr>`;
      }
    }
  }

  /* ---------------------------------------------------------------- login */

  async function login(event) {
    event.preventDefault();
    const input = $('#loginPassword');
    const errorBox = $('#loginError');
    const button = $('#loginBtn');

    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = 'Verificando...';

    try {
      await apiFetch('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: input.value }),
      });
      input.value = '';
      await enterApp();
      toast('Bem-vindo de volta.', 'success');
    } catch (error) {
      errorBox.textContent = error.message || 'Não foi possível entrar.';
      errorBox.hidden = false;
      input.select();
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar no painel';
    }
  }

  async function logout() {
    try {
      await apiFetch('/api/admin/logout', { method: 'POST' });
    } catch {
      /* ignora */
    }
    showLogin();
  }

  /* ---------------------------------------------------------------- bind */

  function bind() {
    $('#loginForm').addEventListener('submit', login);

    $('#togglePassword').addEventListener('click', () => {
      const input = $('#loginPassword');
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      input.focus();
    });

    $('#logoutBtn').addEventListener('click', logout);

    $('#menuBtn').addEventListener('click', openSidebar);
    $('#sidebarClose').addEventListener('click', closeSidebar);
    $('#sidebarOverlay').addEventListener('click', closeSidebar);

    $$('.nav-item[data-view]').forEach((item) => {
      item.addEventListener('click', () => setView(item.dataset.view));
    });

    document.addEventListener('click', (event) => {
      const goto = event.target.closest('[data-goto]');
      if (goto) {
        setView(goto.dataset.goto);
        return;
      }

      const copyButton = event.target.closest('[data-copy-key]');
      if (copyButton) {
        copyText(copyButton.dataset.copyKey).then((ok) => {
          toast(ok ? 'Key copiada.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
        });
        return;
      }

      const endpointCopy = event.target.closest('[data-copy-endpoint]');
      if (endpointCopy) {
        copyText(endpointUrl()).then((ok) => {
          toast(ok ? 'Endpoint copiado.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
        });
      }
    });

    $('#keysSearch').addEventListener(
      'input',
      debounce((event) => {
        state.keys.search = event.target.value.trim();
        state.keys.page = 1;
        loadKeys();
      }, 280),
    );

    $('#keysStatus').addEventListener('change', (event) => {
      state.keys.status = event.target.value;
      state.keys.page = 1;
      loadKeys();
    });

    $('#keysModel').addEventListener('change', (event) => {
      state.keys.model = event.target.value;
      state.keys.page = 1;
      loadKeys();
    });

    $('#keysRefresh').addEventListener('click', loadKeys);

    $('#keysExport').addEventListener('click', () => {
      window.location.assign('/api/admin/export');
    });

    $('#keysPager').addEventListener('click', (event) => {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled) return;
      const page = Number.parseInt(button.dataset.page, 10);
      if (!page || page === state.keys.page) return;
      state.keys.page = page;
      loadKeys();
    });

    $('#keysTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      keyAction(button.dataset.action, button.dataset.key).catch((error) => {
        if (error.status !== 401) toast(error.message, 'error');
      });
    });

    $('#genForm').addEventListener('submit', generateKeys);

    $('#copyAllBtn').addEventListener('click', async () => {
      const text = state.generated.map((item) => item.key).join('\n');
      const ok = await copyText(text);
      toast(ok ? 'Keys copiadas.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
    });

    $('#valForm').addEventListener('submit', testValidation);

    $('#codeTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      state.codeTab = tab.dataset.tab;
      $$('#codeTabs .tab').forEach((item) => item.classList.toggle('is-active', item === tab));
      renderCodeSample();
    });

    $('#copyCodeBtn').addEventListener('click', async () => {
      const ok = await copyText($('#codeSample').textContent);
      toast(ok ? 'Código copiado.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
    });

    $('#copyValidationUrl').addEventListener('click', async () => {
      const ok = await copyText(endpointUrl());
      toast(ok ? 'URL copiada.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
    });

    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#testUrlBtn').addEventListener('click', testUrl);
    $('#passwordForm').addEventListener('submit', changePassword);

    $('#logsFilter').addEventListener('change', loadLogs);
    $('#logsRefresh').addEventListener('click', loadLogs);

    $('#modalConfirm').addEventListener('click', () => settleModal(true));
    $$('#modal [data-close], #modal .modal__backdrop').forEach((element) => {
      element.addEventListener('click', () => settleModal(false));
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('#modal').hidden) settleModal(false);
        closeSidebar();
      }
      if (event.key === '/' && document.activeElement === document.body && !$('#appView').hidden) {
        event.preventDefault();
        setView('keys');
        $('#keysSearch').focus();
      }
    });
  }

  /* ---------------------------------------------------------------- boot */

  async function boot() {
    bind();
    try {
      const me = await apiFetch('/api/admin/me');
      if (me.authenticated) {
        await enterApp();
        return;
      }
    } catch {
      /* não autenticado */
    }
    showLogin();
  }

  boot();
})();
