/* javascript / public/services/services.js / browser runtime / LEGION admin panel */
(() => {
  'use strict';

  const services = [
    { id: 'license', icon: '◈', name: 'Licenças', text: 'validação e vínculo de HWID', tone: 'violet', endpoint: '/api/health' },
    { id: 'keygen', icon: '+', name: 'Keygen', text: 'criação de keys por modelo', tone: 'cyan', endpoint: '/api/config' },
    { id: 'validation', icon: '✓', name: 'Validação', text: 'endpoint público de acesso', tone: 'green', endpoint: '/api/validate' },
    { id: 'download', icon: '↓', name: 'Downloads', text: 'entrega dos binários legion', tone: 'gold', endpoint: '/download.html' },
    { id: 'security', icon: '⌁', name: 'Segurança', text: 'sessão administrativa protegida', tone: 'rose', endpoint: '/api/admin/me' },
  ];

  const state = new Map(services.map((service) => [service.id, { status: 'checking', detail: 'verificando...' }]));

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function render() {
    const root = document.getElementById('serviceGrid');
    if (!root) return;
    root.innerHTML = services.map((service) => {
      const item = state.get(service.id);
      const online = item.status === 'online';
      return `<article class="service-card service-card--${service.tone}">
        <div class="service-card__top"><span class="service-icon">${escapeHtml(service.icon)}</span><span class="service-state ${online ? 'is-online' : item.status === 'offline' ? 'is-offline' : ''}"><i></i>${escapeHtml(item.status === 'checking' ? 'checando' : online ? 'online' : 'indisponível')}</span></div>
        <h3>${escapeHtml(service.name)}</h3><p>${escapeHtml(service.text)}</p>
        <div class="service-card__foot"><span>${escapeHtml(item.detail)}</span><code>${escapeHtml(service.endpoint)}</code></div>
      </article>`;
    }).join('');
  }

  async function check(service) {
    try {
      const response = await fetch(service.endpoint, { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      state.set(service.id, { status: response.ok || response.status === 401 ? 'online' : 'offline', detail: `HTTP ${response.status}` });
    } catch (error) {
      state.set(service.id, { status: 'offline', detail: error.name === 'TimeoutError' ? 'tempo esgotado' : 'sem resposta' });
    }
  }

  async function refresh() {
    render();
    await Promise.all(services.map(check));
    render();
  }

  function init() {
    document.getElementById('servicesRefresh')?.addEventListener('click', refresh);
    refresh();
  }

  window.LegionServices = { init, refresh };
})();
