/* LEGION — site público
 * app.js · consome /api/config, /api/stats, /api/generate
 * Modelos: PRIVATE / HEADTRICK / INTERNAL
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const STORAGE_KEY = 'legion.cooldown.v1';

  const FALLBACK_MODELS = [
    { id: 'private', prefix: 'PRIVATE', label: 'PRIVATE', color: '#a78bfa', enabled: true },
    { id: 'headtrick', prefix: 'HEADTRICK', label: 'HEADTRICK', color: '#ff6b4a', enabled: true },
    { id: 'internal', prefix: 'INTERNAL', label: 'INTERNAL', color: '#35e08c', enabled: true },
  ];

  const state = {
    cfg: {
      brand: 'LEGION',
      apiBase: '',
      publicUrl: '',
      models: FALLBACK_MODELS,
      cooldownSeconds: 120,
      defaultDurationDays: 30,
      maintenance: false,
      version: '1.0.0',
    },
    model: 'private',
    busy: false,
    cooldown: { until: 0, total: 0, timer: null, scramble: null },
  };

  const els = {
    keyDisplay: $('#keyDisplay'),
    keyText: $('#keyText'),
    copyKeyBtn: $('#copyKeyBtn'),
    generateBtn: $('#generateBtn'),
    generateLabel: $('#generateBtnLabel'),
    genMsg: $('#genMsg'),
    metaDuration: $('#metaDuration'),
    metaCooldown: $('#metaCooldown'),
    cooldownWrap: $('#cooldownWrap'),
    cooldownBar: $('#cooldownBar'),
    cooldownText: $('#cooldownText'),
    statTotal: $('#statTotal'),
    statActive: $('#statActive'),
    statToday: $('#statToday'),
    endpointText: $('#endpointText'),
    copyEndpointBtn: $('#copyEndpointBtn'),
    apiSample: $('#apiSample'),
    maintenance: $('#maintenanceBanner'),
    toastRoot: $('#toastRoot'),
    year: $('#year'),
    modelGrid: $('#modelGrid'),
    modelChip: $('#modelChip'),
  };

  /* ---------------------------------------------------------------- utils */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });
  }

  function apiUrl(pathname) {
    const base = String(state.cfg.apiBase || '').replace(/\/+$/, '');
    return `${base}${pathname}`;
  }

  function validationUrl() {
    const base = String(state.cfg.publicUrl || state.cfg.apiBase || '').replace(/\/+$/, '');
    if (base) return `${base}/api/validate`;
    return new URL('/api/validate', window.location.href).href;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
  }

  function randomGroup() {
    let out = '';
    for (let i = 0; i < 4; i += 1) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return out;
  }

  function humanDuration(days) {
    const n = Number(days);
    if (!n) return 'Vitalícia';
    return `${n} ${n === 1 ? 'dia' : 'dias'}`;
  }

  function mmss(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function models() {
    const list = Array.isArray(state.cfg.models) ? state.cfg.models : [];
    return list.length ? list : FALLBACK_MODELS;
  }

  function modelById(id) {
    return models().find((model) => model.id === id) || models()[0];
  }

  function currentModel() {
    return modelById(state.model);
  }

  /* ---------------------------------------------------------------- toast */

  const TOAST_ICONS = {
    ok: '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.5 4.5L19 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.2" fill="currentColor"/><path d="M10.3 3.8 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.8a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>',
  };

  function toast(message, type = 'info') {
    if (!els.toastRoot) return;
    const node = document.createElement('div');
    node.className = `toast toast--${type === 'success' ? 'ok' : type === 'error' ? 'error' : 'info'}`;
    node.innerHTML = `<span class="toast__icon">${TOAST_ICONS[type === 'success' ? 'ok' : type] || TOAST_ICONS.info}</span><span>${escapeHtml(message)}</span>`;
    els.toastRoot.appendChild(node);
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
      /* cai no fallback */
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

  /* ---------------------------------------------------------------- modelos */

  function renderModelAvailability() {
    $$('.model-card').forEach((card) => {
      const model = models().find((item) => item.id === card.dataset.model);
      const enabled = model ? model.enabled !== false : true;
      card.disabled = !enabled;
      card.title = enabled
        ? `${model ? model.prefix : card.dataset.model} — ${model ? model.description || '' : ''}`.trim()
        : 'Gerador desativado';
      const name = card.querySelector('.model-card__name');
      if (name && model) name.textContent = model.label || model.prefix;
    });

    const active = models().find((model) => model.id === state.model);
    if (!active || active.enabled === false) {
      const fallback = models().find((model) => model.enabled !== false);
      if (fallback) selectModel(fallback.id, { silent: true });
    }
  }

  function selectModel(id, options = {}) {
    const model = models().find((item) => item.id === id);
    if (!model || model.enabled === false) return false;

    state.model = model.id;
    $$('.model-card').forEach((card) => {
      const active = card.dataset.model === model.id;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (els.modelChip) els.modelChip.textContent = model.label;
    if (els.keyDisplay && els.keyDisplay.classList.contains('is-empty')) {
      els.keyText.textContent = `${model.prefix}-XXXX-XXXX`;
    }
    renderSample(validationUrl());
    if (!options.silent) {
      showMessage(`Modelo ${model.label} selecionado. Gere sua key.`, '');
    }
    return true;
  }

  /* ---------------------------------------------------------------- config */

  function applyConfig(cfg) {
    state.cfg = { ...state.cfg, ...cfg };
    if (!Array.isArray(state.cfg.models) || !state.cfg.models.length) {
      state.cfg.models = FALLBACK_MODELS;
    }

    $$('[data-brand]').forEach((node) => {
      node.textContent = state.cfg.brand;
    });
    document.title = `${state.cfg.brand} — Key System`;

    if (els.metaDuration) {
      els.metaDuration.textContent = humanDuration(state.cfg.defaultDurationDays);
    }
    if (els.metaCooldown) {
      els.metaCooldown.textContent =
        state.cfg.cooldownSeconds > 0 ? `${state.cfg.cooldownSeconds}s` : 'sem espera';
    }

    const heroDuration = $('#heroDuration');
    if (heroDuration) {
      heroDuration.textContent =
        state.cfg.defaultDurationDays > 0
          ? `Validade de ${state.cfg.defaultDurationDays} dias`
          : 'Validade vitalícia';
    }

    renderModelAvailability();
    const active = models().find((model) => model.id === state.model);
    if (active && active.enabled !== false) selectModel(active.id, { silent: true });

    const endpoint = validationUrl();
    if (els.endpointText) els.endpointText.textContent = endpoint;
    renderSample(endpoint);

    const statusPill = document.querySelector('.header-actions .status-pill');
    if (statusPill) {
      statusPill.classList.toggle('is-warn', Boolean(state.cfg.maintenance));
      statusPill.innerHTML = `<span class="dot"></span> ${state.cfg.maintenance ? 'MANUTENÇÃO' : 'ONLINE'}`;
    }

    if (state.cfg.maintenance) {
      if (els.maintenance) els.maintenance.hidden = false;
      setButtonState('maintenance');
    }

    if (els.year) els.year.textContent = String(new Date().getFullYear());
  }

  async function loadConfig() {
    let cfg = window.LEGION_CONFIG && typeof window.LEGION_CONFIG === 'object' ? window.LEGION_CONFIG : {};
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (response.ok) {
        const live = await response.json();
        cfg = { ...cfg, ...live };
      }
    } catch {
      /* mantém o config.js */
    }
    applyConfig(cfg);
    if (!state.cfg.maintenance) setButtonState('idle');
  }

  /* ---------------------------------------------------------------- sample */

  function renderSample(endpoint) {
    if (!els.apiSample) return;
    const prefix = escapeHtml(currentModel().prefix);
    const url = escapeHtml(endpoint);
    els.apiSample.innerHTML = [
      `<span class="tok-cmd">curl</span> <span class="tok-flag">-X POST</span> <span class="tok-url">'${url}'</span> \\`,
      `  <span class="tok-flag">-H</span> <span class="tok-str">'Content-Type: application/json'</span> \\`,
      `  <span class="tok-flag">-d</span> <span class="tok-str">'{"key":"${prefix}-X7K9-P2QM","hwid":"SEU-HWID"}'</span>`,
    ].join('\n');
  }

  /* ---------------------------------------------------------------- stats */

  function animateNumber(node, target) {
    if (!node) return;
    const from = Number(node.dataset.value || 0);
    const to = Number(target) || 0;
    node.dataset.value = String(to);
    if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.textContent = formatNumber(to);
      return;
    }
    const started = performance.now();
    const duration = 650;
    const tick = (time) => {
      const progress = Math.min(1, (time - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      node.textContent = formatNumber(Math.round(from + (to - from) * eased));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function renderModelCounts(byModel) {
    $$('[data-model-count]').forEach((node) => {
      const count = Number(byModel && byModel[node.dataset.modelCount]) || 0;
      node.textContent = `${formatNumber(count)} ${count === 1 ? 'key' : 'keys'}`;
    });
  }

  async function loadStats() {
    try {
      const response = await fetch(apiUrl('/api/stats'), { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      animateNumber(els.statTotal, data.totalKeys);
      animateNumber(els.statActive, data.activeKeys);
      animateNumber(els.statToday, data.generatedToday);
      renderModelCounts(data.byModel);
    } catch {
      /* silencioso */
    }
  }

  /* ---------------------------------------------------------------- keygen */

  function setButtonState(mode) {
    if (!els.generateBtn) return;
    if (mode === 'maintenance') {
      els.generateBtn.disabled = true;
      els.generateLabel.textContent = 'Em manutenção';
      return;
    }
    if (mode === 'busy') {
      els.generateBtn.disabled = true;
      els.generateLabel.textContent = 'Gerando...';
      els.generateBtn.classList.add('is-loading');
      return;
    }
    if (mode === 'cooldown') {
      els.generateBtn.disabled = true;
      els.generateBtn.classList.remove('is-loading');
      els.generateLabel.textContent = 'Aguarde';
      return;
    }
    els.generateBtn.disabled = false;
    els.generateBtn.classList.remove('is-loading');
    els.generateLabel.textContent = 'Gerar minha key';
  }

  function placeholderKey() {
    els.keyText.textContent = `${currentModel().prefix}-XXXX-XXXX`;
    els.keyDisplay.classList.add('is-empty');
    els.keyDisplay.classList.remove('has-key', 'revealed');
    els.copyKeyBtn.disabled = true;
  }

  function startScramble() {
    stopScramble();
    const prefix = currentModel().prefix;
    els.keyDisplay.classList.remove('is-empty', 'has-key', 'revealed');
    els.keyText.style.opacity = '0.7';
    state.cooldown.scramble = window.setInterval(() => {
      els.keyText.textContent = `${prefix}-${randomGroup()}-${randomGroup()}`;
    }, 55);
  }

  function stopScramble() {
    if (state.cooldown.scramble) {
      window.clearInterval(state.cooldown.scramble);
      state.cooldown.scramble = null;
    }
    els.keyText.style.opacity = '';
  }

  function revealKey(key) {
    stopScramble();
    els.keyText.textContent = key;
    els.keyDisplay.classList.remove('is-empty');
    els.keyDisplay.classList.add('has-key', 'revealed');
    els.copyKeyBtn.disabled = false;
    window.setTimeout(() => els.keyDisplay.classList.remove('revealed'), 600);
  }

  function showMessage(text, type) {
    els.genMsg.textContent = text || '';
    els.genMsg.classList.remove('is-ok', 'is-error');
    if (type === 'ok') els.genMsg.classList.add('is-ok');
    if (type === 'error') els.genMsg.classList.add('is-error');
  }

  /* ---------------------------------------------------------------- cooldown */

  function readStoredCooldown() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && Number(raw.until) > Date.now()) return raw;
    } catch {
      /* ignora */
    }
    return null;
  }

  function startCooldown(until, totalSeconds) {
    const total = Math.max(1, Number(totalSeconds) || Math.ceil((until - Date.now()) / 1000));
    state.cooldown.until = until;
    state.cooldown.total = total;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ until, total }));
    } catch {
      /* ignora */
    }
    if (els.cooldownWrap) els.cooldownWrap.hidden = false;
    setButtonState('cooldown');
    renderCooldown();
    window.clearInterval(state.cooldown.timer);
    state.cooldown.timer = window.setInterval(renderCooldown, 500);
  }

  function clearCooldown() {
    state.cooldown.until = 0;
    window.clearInterval(state.cooldown.timer);
    state.cooldown.timer = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignora */
    }
    if (els.cooldownWrap) els.cooldownWrap.hidden = true;
    if (!state.cfg.maintenance) setButtonState('idle');
  }

  function renderCooldown() {
    const left = state.cooldown.until - Date.now();
    if (left <= 0) {
      clearCooldown();
      return;
    }
    const ratio = Math.max(0, Math.min(1, left / (state.cooldown.total * 1000)));
    if (els.cooldownBar) els.cooldownBar.style.width = `${ratio * 100}%`;
    if (els.cooldownText) {
      els.cooldownText.textContent = `Próxima key disponível em ${mmss(left)}`;
    }
    if (els.generateLabel && els.generateBtn.disabled) {
      els.generateLabel.textContent = `Aguarde ${mmss(left)}`;
    }
  }

  function restoreCooldown() {
    const stored = readStoredCooldown();
    if (stored) startCooldown(stored.until, stored.total);
  }

  /* ---------------------------------------------------------------- generate */

  async function generate() {
    if (state.busy) return;
    if (state.cfg.maintenance) {
      toast('Sistema em manutenção. Tente mais tarde.', 'error');
      return;
    }
    if (state.cooldown.until > Date.now()) {
      toast(`Aguarde ${mmss(state.cooldown.until - Date.now())} para gerar outra key.`, 'info');
      return;
    }

    const model = currentModel();
    if (!model || model.enabled === false) {
      toast('Este gerador está desativado.', 'error');
      return;
    }

    state.busy = true;
    setButtonState('busy');
    showMessage(`Gerando key ${model.label}...`, '');
    startScramble();

    try {
      const response = await fetch(apiUrl('/api/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'web', model: state.model }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        stopScramble();
        placeholderKey();
        if (data.retryAfter) {
          startCooldown(Date.now() + data.retryAfter * 1000, data.retryAfter);
        }
        if (data.code === 'maintenance') {
          state.cfg.maintenance = true;
          els.maintenance.hidden = false;
          setButtonState('maintenance');
        }
        if (data.code === 'model_disabled') {
          const target = models().find((item) => item.id === state.model);
          if (target) target.enabled = false;
          renderModelAvailability();
        }
        throw new Error(data.message || 'Não foi possível gerar a key agora.');
      }

      const generated = modelById(data.model || state.model);
      window.setTimeout(() => revealKey(data.key), 420);
      showMessage(
        data.durationDays > 0
          ? `Key ${generated.label} gerada. Ative no loader — validade de ${data.durationDays} dias após a ativação.`
          : `Key ${generated.label} vitalícia gerada. Ative no loader.`,
        'ok',
      );
      toast(`Key ${generated.label} gerada.`, 'success');
      if (data.cooldownSeconds > 0) {
        startCooldown(Date.now() + data.cooldownSeconds * 1000, data.cooldownSeconds);
      }
      loadStats();
    } catch (err) {
      stopScramble();
      if (!els.keyDisplay.classList.contains('has-key')) placeholderKey();
      const message = err instanceof Error ? err.message : 'Erro inesperado.';
      showMessage(message, 'error');
      toast(message, 'error');
    } finally {
      state.busy = false;
      if (state.cooldown.until <= Date.now() && !state.cfg.maintenance) {
        setButtonState('idle');
      }
    }
  }

  /* ---------------------------------------------------------------- bind */

  function bind() {
    els.generateBtn.addEventListener('click', generate);

    if (els.modelGrid) {
      els.modelGrid.addEventListener('click', (event) => {
        const card = event.target.closest('[data-model]');
        if (!card || card.disabled) return;
        selectModel(card.dataset.model);
      });
    }

    els.copyKeyBtn.addEventListener('click', async () => {
      const key = els.keyText.textContent.trim();
      if (!key || els.copyKeyBtn.disabled) return;
      const ok = await copyText(key);
      toast(ok ? 'Key copiada.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
    });

    els.copyEndpointBtn.addEventListener('click', async () => {
      const ok = await copyText(validationUrl());
      toast(ok ? 'Endpoint copiado.' : 'Não foi possível copiar.', ok ? 'success' : 'error');
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.cooldown.until) renderCooldown();
    });
  }

  /* ---------------------------------------------------------------- boot */

  async function boot() {
    placeholderKey();
    showMessage('Escolha o modelo e gere sua key de acesso.', '');
    bind();
    await loadConfig();
    restoreCooldown();
    loadStats();
    if (els.year) els.year.textContent = String(new Date().getFullYear());
  }

  boot();
})();
