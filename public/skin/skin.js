/* javascript / public/skin/skin.js / browser runtime / LEGION admin panel */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const storageKey = 'legion.skinApiBase';
  const state = { items: [], applied: 0, connected: false, base: '', loading: false };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function baseUrl() {
    return String(state.base || '').trim().replace(/\/+$/, '');
  }

  function setStatus(label, text, connected) {
    $('skinStatusLabel').textContent = label;
    $('skinStatusText').textContent = text;
    $('skinStatusDot').classList.toggle('is-online', Boolean(connected));
  }

  function renderMetrics(data) {
    $('skinMetricCatalog').textContent = String(state.items.length);
    $('skinMetricApplied').textContent = String(data.applied || 0);
    $('skinMetricMode').textContent = data.loaded ? 'pronto' : 'aguardando';
    $('skinResultCount').textContent = `${state.items.length} ITENS`;
  }

  function renderActive(count) {
    const root = $('skinActiveList');
    if (!count) {
      root.innerHTML = '<div class="skin-empty skin-empty--small">nenhuma skin aplicada.</div>';
      return;
    }
    root.innerHTML = `<div class="skin-active-state"><span class="skin-active-icon">✦</span><div><b>${count} visual${count === 1 ? '' : 'is'} ativo${count === 1 ? '' : 's'}</b><small>a sessão está sincronizada</small></div></div>`;
  }

  function renderItems() {
    const root = $('skinGrid');
    const term = $('skinSearch').value.trim().toLowerCase();
    const category = $('skinCategory').value;
    const items = state.items.filter((item) => {
      const text = `${item.description} ${item.id} ${item.category}`.toLowerCase();
      return (!term || text.includes(term)) && (category === 'all' || text.includes(category));
    });
    $('skinResultCount').textContent = `${items.length} ITENS`;
    if (!items.length) {
      root.innerHTML = '<div class="skin-empty">nenhum visual encontrado com esses filtros.</div>';
      return;
    }
    root.innerHTML = items.map((item) => `<article class="skin-card">
      <div class="skin-card__visual"><span>✦</span><small>#${esc(item.id)}</small></div>
      <div class="skin-card__body"><span class="skin-card__category">${esc(item.category || 'skin')}</span><h3>${esc(item.description || 'visual sem nome')}</h3><small>${esc(item.rarity || 'catálogo legion')}</small></div>
      <button class="skin-apply" type="button" data-skin-id="${esc(item.id)}" aria-label="Aplicar ${esc(item.description)}">aplicar</button>
    </article>`).join('');
  }

  async function request(path, options = {}) {
    const base = baseUrl();
    if (!base) throw new Error('configure o endpoint local do skin changer.');
    const response = await fetch(`${base}${path}`, { ...options, mode: 'cors', signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.err || data.error || `endpoint respondeu HTTP ${response.status}`);
    return data;
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    setStatus('conectando', 'lendo catálogo local...', false);
    try {
      const data = await request('/api/skins?cat=-1&limit=500');
      state.items = Array.isArray(data.items) ? data.items : [];
      state.applied = Number(data.applied || 0);
      state.connected = true;
      renderMetrics(data); renderActive(state.applied); renderItems();
      setStatus('online', data.status || 'skin changer sincronizado', true);
    } catch (error) {
      state.connected = false;
      setStatus('offline', error.message, false);
      $('skinMetricMode').textContent = 'offline';
      renderItems();
    } finally { state.loading = false; }
  }

  async function apply(id) {
    try {
      const data = await request(`/api/skin?action=apply&id=${encodeURIComponent(id)}`);
      state.applied = Number.isFinite(Number(data.count)) ? Number(data.count) : state.applied;
      renderActive(state.applied); $('skinMetricApplied').textContent = String(state.applied);
      window.LegionSkinPanel.toast('visual aplicado.', 'success');
    } catch (error) { window.LegionSkinPanel.toast(error.message, 'error'); }
  }

  async function clear() {
    try { await request('/api/skin?action=clear'); state.applied = 0; renderActive(0); $('skinMetricApplied').textContent = '0'; window.LegionSkinPanel.toast('skins removidas.', 'success'); }
    catch (error) { window.LegionSkinPanel.toast(error.message, 'error'); }
  }

  function toast(message, type) {
    const fn = window.__legionAdminToast;
    if (fn) fn(message, type);
  }

  function init() {
    state.base = localStorage.getItem(storageKey) || '';
    $('skinApiBase').value = state.base;
    $('skinSaveEndpoint').addEventListener('click', () => { state.base = $('skinApiBase').value.trim(); localStorage.setItem(storageKey, state.base); refresh(); });
    $('skinRefresh').addEventListener('click', refresh);
    $('skinClear').addEventListener('click', clear);
    $('skinSearch').addEventListener('input', renderItems);
    $('skinCategory').addEventListener('change', renderItems);
    $('skinGrid').addEventListener('click', (event) => { const button = event.target.closest('[data-skin-id]'); if (button) apply(button.dataset.skinId); });
  }

  window.LegionSkinPanel = { init, refresh, toast };
})();
