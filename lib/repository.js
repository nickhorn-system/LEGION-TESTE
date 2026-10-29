'use strict';

const { supabase } = require('./supabase');
const {
  MODELS,
  MODEL_MAP,
  PUBLIC_DURATIONS,
  nowIso,
  dayKey,
  startOfToday,
  secondsUntilTomorrow,
  randomChars,
  normalizeKey,
  parseKey,
  statusOf,
  daysLeftOf,
  hashPassword,
  verifyPassword,
  generatePassword,
  clampInt,
  normalizeUrl,
  normalizeModels,
  modelsConfig,
  validateBusinessRules,
  successPayload,
  VALIDATION_CODES,
} = require('./util');

const MAX_LOGS = 1000;
const MAX_METRICS_DAYS = 90;

// Rate-limit em memória por chave (protege contra abuso em chaves específicas).
const keyBuckets = new Map(); // key -> { count, reset }
/* ------------------------------------------------------------------ *
 * Mapeamento linha Supabase (snake_case) -> item (camelCase)         *
 * ------------------------------------------------------------------ */

function rowToItem(row) {
  if (!row) return null;
  return {
    key: row.key,
    model: row.model || 'private',
    status: statusOf(row), // computado na hora
    durationDays: row.duration_days ?? 30,
    plan: row.plan || 'standard',
    note: row.note || '',
    createdBy: row.created_by || 'web',
    ip: row.ip || '',
    hwid: row.hwid || '',
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    lastCheckAt: row.last_check_at,
    uses: row.uses ?? 0,
    revoked: Boolean(row.revoked),
    daysLeft: daysLeftOf(row),
  };
}

function itemToRow(item) {
  return {
    key: item.key,
    model: item.model,
    duration_days: item.durationDays,
    plan: item.plan,
    note: item.note,
    created_by: item.createdBy,
    ip: item.ip,
    hwid: item.hwid,
    created_at: item.createdAt,
    activated_at: item.activatedAt,
    expires_at: item.expiresAt,
    last_check_at: item.lastCheckAt,
    uses: item.uses,
    revoked: item.revoked,
  };
}

async function ensureSchema() {
  // Tenta criar/garantir a tabela config via upsert (cria se nao existir).
  try {
    const { error } = await supabase
      .from('config')
      .upsert({ id: 1, brand: 'LEGION' }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) {
      console.error('[repository] ensureSchema config:', error.message);
    }
  } catch (e) {
    console.error('[repository] ensureSchema config exception:', e.message);
  }

  // Tenta garantir a tabela keys via insert de teste (falha silenciosamente se ja existir).
  try {
    const { error } = await supabase
      .from('keys')
      .select('key')
      .limit(1);
    if (error && error.code === '42P01') {
      console.error('[repository] ensureSchema: tabela "keys" nao existe. Rode supabase-schema.sql no Supabase.');
    }
  } catch (e) {
    console.error('[repository] ensureSchema keys exception:', e.message);
  }

  // Tenta garantir a tabela logs.
  try {
    const { error } = await supabase
      .from('logs')
      .select('id')
      .limit(1);
    if (error && error.code === '42P01') {
      console.error('[repository] ensureSchema: tabela "logs" nao existe. Rode supabase-schema.sql no Supabase.');
    }
  } catch (e) {
    console.error('[repository] ensureSchema logs exception:', e.message);
  }

  // Tenta garantir a tabela metrics.
  try {
    const { error } = await supabase
      .from('metrics')
      .select('day_key')
      .limit(1);
    if (error && error.code === '42P01') {
      console.error('[repository] ensureSchema: tabela "metrics" nao existe. Rode supabase-schema.sql no Supabase.');
    }
  } catch (e) {
    console.error('[repository] ensureSchema metrics exception:', e.message);
  }
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function check(result, context) {
  if (result.error) {
    console.error(`[repository] ${context}:`, result.error.message);
    throw httpError(500, `Erro no banco (${context}).`);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Configuracao                                                       *
 * ------------------------------------------------------------------ */

async function getConfigRow() {
  const result = await check(
    await supabase.from('config').select('*').eq('id', 1).single(),
    'getConfigRow'
  );
  return result.data;
}

async function getConfig() {
  const row = await getConfigRow();
  return {
    version: 1,
    config: {
      brand: row.brand || 'LEGION',
      publicUrl: row.public_url || '',
      apiBase: row.api_base || '',
      models: normalizeModels(row.models),
      cooldownSeconds: row.cooldown_seconds ?? 0,
      dailyLimit: row.daily_limit ?? 0,
      defaultDurationDays: row.default_duration_days ?? 30,
      maintenance: Boolean(row.maintenance),
      adminPassword: row.admin_password || null,
      createdAt: row.created_at,
    },
  };
}

function publicConfig(config) {
  const cfg = config.config;
  const joinUrl = (base, suffix) => {
    const clean = String(base || '').replace(/\/+$/, '');
    return clean ? `${clean}${suffix}` : suffix;
  };
  return {
    brand: cfg.brand,
    publicUrl: cfg.publicUrl,
    apiBase: cfg.apiBase,
    models: modelsConfig(cfg.models),
    durations: PUBLIC_DURATIONS,
    cooldownSeconds: cfg.cooldownSeconds,
    dailyLimit: cfg.dailyLimit,
    defaultDurationDays: cfg.defaultDurationDays,
    maintenance: cfg.maintenance,
    version: 1,
    validationUrl: joinUrl(cfg.publicUrl, '/api/validate'),
  };
}

function clientConfig(config) {
  const cfg = config.config;
  const trimSlash = (v) => String(v || '').replace(/\/+$/, '');
  const joinUrl = (base, suffix) => {
    const clean = trimSlash(base);
    return clean ? `${clean}${suffix}` : suffix;
  };
  return {
    brand: cfg.brand,
    apiBase: trimSlash(cfg.apiBase),
    publicUrl: trimSlash(cfg.publicUrl),
    models: modelsConfig(cfg.models),
    durations: PUBLIC_DURATIONS,
    cooldownSeconds: cfg.cooldownSeconds,
    dailyLimit: cfg.dailyLimit,
    defaultDurationDays: cfg.defaultDurationDays,
    maintenance: cfg.maintenance,
    version: 1,
    validationUrl: joinUrl(cfg.publicUrl, '/api/validate'),
  };
}

function settingsPayload(config) {
  const cfg = config.config;
  return {
    brand: cfg.brand,
    publicUrl: cfg.publicUrl,
    apiBase: cfg.apiBase,
    models: modelsConfig(cfg.models),
    cooldownSeconds: cfg.cooldownSeconds,
    dailyLimit: cfg.dailyLimit,
    defaultDurationDays: cfg.defaultDurationDays,
    maintenance: cfg.maintenance,
    createdAt: cfg.createdAt,
    version: 1,
  };
}

async function updateConfig(patch) {
  const allowed = {
    brand: 'brand',
    publicUrl: 'public_url',
    apiBase: 'api_base',
    models: 'models',
    cooldownSeconds: 'cooldown_seconds',
    dailyLimit: 'daily_limit',
    defaultDurationDays: 'default_duration_days',
    maintenance: 'maintenance',
    adminPassword: 'admin_password',
  };
  const updates = {};
  for (const [inputKey, dbKey] of Object.entries(allowed)) {
    if (inputKey in patch) updates[dbKey] = patch[inputKey];
  }
  if (Object.keys(updates).length === 0) {
    return getConfig();
  }
  await check(
    await supabase.from('config').update(updates).eq('id', 1),
    'updateConfig'
  );
  return getConfig();
}

/* ------------------------------------------------------------------ *
 * Inicializacao (garante linha de configuracao e senha admin)        *
 * ------------------------------------------------------------------ */

let bootGeneratedPassword = null;

async function init(opts = {}) {
  // Garante que as tabelas existam antes de prosseguir.
  await ensureSchema();

  // Garante a linha unica de configuracao.
  await check(
    await supabase
      .from('config')
      .upsert({ id: 1 }, { onConflict: 'id', ignoreDuplicates: true }),
    'init config'
  );

  const config = await getConfig();
  const envPassword = process.env.ADMIN_PASSWORD || opts.adminPassword;

  if (!config.config.adminPassword) {
    const password = envPassword || generatePassword();
    bootGeneratedPassword = envPassword ? null : password;
    await updateConfig({ adminPassword: hashPassword(password) });
  } else if (envPassword && !opts.ignoreEnvPassword) {
    // Senha fornecida via env mas ja existe: substitui e invalida sessoes.
    await updateConfig({ adminPassword: hashPassword(envPassword) });
    bootGeneratedPassword = null;
  }

  return { config: await getConfig(), bootGeneratedPassword };
}

function getBootGeneratedPassword() {
  return bootGeneratedPassword;
}

/* ------------------------------------------------------------------ *
 * Keys                                                               *
 * ------------------------------------------------------------------ */

async function getKeys() {
  const result = await check(
    await supabase.from('keys').select('*').order('created_at', { ascending: false }),
    'getKeys'
  );
  return (result.data || []).map(rowToItem);
}

async function getKey(key) {
  const normalized = normalizeKey(key);
  const result = await check(
    await supabase.from('keys').select('*').eq('key', normalized).maybeSingle(),
    'getKey'
  );
  return rowToItem(result.data);
}

async function getKeysByIpAndSource(ip, createdBy) {
  const result = await check(
    await supabase
      .from('keys')
      .select('*')
      .eq('ip', ip)
      .eq('created_by', createdBy)
      .order('created_at', { ascending: false }),
    'getKeysByIpAndSource'
  );
  return (result.data || []).map(rowToItem);
}

async function createKey(model) {
  const modelDef = MODEL_MAP.get(model);
  if (!modelDef) throw httpError(400, 'Modelo invalido.', { field: 'model' });

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const body = randomChars(8);
    const key = `${modelDef.prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
    const existing = await getKey(key);
    if (existing) continue;
    return key;
  }
  throw httpError(500, 'Nao foi possivel gerar uma key unica.');
}

async function addKey(item) {
  await check(
    await supabase.from('keys').insert(itemToRow(item)),
    'addKey'
  );
  return item;
}

async function updateKey(key, changes) {
  const normalized = normalizeKey(key);
  const row = {};
  const fieldMap = {
    model: 'model', durationDays: 'duration_days', plan: 'plan', note: 'note',
    createdBy: 'created_by', ip: 'ip', hwid: 'hwid', createdAt: 'created_at',
    activatedAt: 'activated_at', expiresAt: 'expires_at', lastCheckAt: 'last_check_at',
    uses: 'uses', revoked: 'revoked',
  };
  for (const [inputKey, dbKey] of Object.entries(fieldMap)) {
    if (inputKey in changes) row[dbKey] = changes[inputKey];
  }
  if (Object.keys(row).length === 0) return getKey(normalized);
  await check(
    await supabase.from('keys').update(row).eq('key', normalized),
    'updateKey'
  );
  return getKey(normalized);
}

/**
 * Ativa o vinculo de HWID de forma atomica.
 * Usa condicao hwid IS NULL para evitar race condition: apenas a primeira
 * requisicao consegue gravar; as demais encontram hwig preenchido e retornam
 * HWID_MISMATCH na camada de negocio.
 */
async function activateHwidAtomic(key, hwid, expiresAt) {
  const normalized = normalizeKey(key);
  const { error } = await supabase
    .from('keys')
    .update({
      hwid,
      activated_at: nowIso(),
      expires_at: expiresAt,
    })
    .eq('key', normalized)
    .is('hwid', null); // so grava se ainda nao houver HWID vinculado

  if (error) {
    console.error('[repository] activateHwidAtomic:', error.message);
    throw httpError(500, 'Erro ao vincular HWID.');
  }

  // Verifica se realmente foi ativado (outro processo pode ter vencido).
  const updated = await getKey(normalized);
  if (!updated || updated.hwid !== hwid) {
    // Outro processo vinculou primeiro.
    return null;
  }
  return updated;
}

async function deleteKey(key) {
  const normalized = normalizeKey(key);
  const existing = await getKey(normalized);
  if (!existing) return null;
  await check(
    await supabase.from('keys').delete().eq('key', normalized),
    'deleteKey'
  );
  return existing;
}

/* ------------------------------------------------------------------ *
 * Validacao de key                                                   *
 * ------------------------------------------------------------------ */

function fail(code, message, record = null, parsed = null, now = Date.now()) {
  return {
    payload: {
      valid: false,
      code,
      message,
      key: null,
      model: record ? record.model : parsed ? parsed.model.id : null,
      plan: record ? record.plan : null,
      durationDays: record ? record.durationDays : null,
      activatedAt: record ? record.activatedAt : null,
      expiresAt: record ? record.expiresAt : null,
      daysLeft: record ? daysLeftOf(record, now) : null,
      hwidBound: record ? Boolean(record.hwid) : false,
      checkedAt: nowIso(),
    },
    dirty: false,
  };
}

/**
 * Valida uma key aplicando todas as regras de negocio centralizadas.
 * Esta funcao e usada tanto pela rota publica quanto pelo painel admin.
 *
 * @param {string} rawKey - Key bruta informada pelo cliente
 * @param {string} rawHwid - HWID bruto informado pelo cliente
 * @param {string} requestedModel - Modelo/produto solicitado (opcional)
 * @returns {object} { payload: { valid, code, message, ... }, dirty: boolean }
 */
async function validateKey(rawKey, rawHwid, requestedModel = null) {
  const key = normalizeKey(rawKey);
  // HWID é case-insensitive: o painel e o loader podem representar o mesmo
  // identificador com capitalização diferente.
  const hwid = String(rawHwid || '').trim().toUpperCase();
  const now = Date.now();
  const parsed = parseKey(key);

  if (!parsed) {
    return fail(VALIDATION_CODES.INVALID_FORMAT, 'Formato de key invalido.', null, parsed, now);
  }

  // Rate-limit por chave (protege contra abuso em chaves especificas).
  const bucketKey = `validate:${key}`;
  const nowMs = Date.now();
  let bucket = keyBuckets.get(bucketKey);
  if (!bucket || bucket.reset <= nowMs) {
    bucket = { count: 0, reset: nowMs + 60 * 1000 };
    keyBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (bucket.count > 60) {
    return fail(VALIDATION_CODES.RATE_LIMITED, 'Muitas validacoes para esta key. Aguarde um instante.');
  }

  let record;
  try {
    record = await getKey(key);
  } catch (err) {
    // Banco de dados nao configurado ou tabelas nao criadas
    console.error('[repository] validateKey getKey falhou:', err.message);
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.SERVER_ERROR,
        message: 'Servidor de licenca nao esta configurado. Contate o suporte.',
        key: null,
        model: parsed ? parsed.model : null,
        plan: null,
        durationDays: null,
        activatedAt: null,
        expiresAt: null,
        daysLeft: null,
        hwidBound: false,
        checkedAt: nowIso(),
      },
      dirty: false,
    };
  }

  // Aplica regras de negocio centralizadas.
  const business = validateBusinessRules(record, hwid, requestedModel || parsed.model.id, now);
  if (business) return business;

  // Ativacao atomica de HWID (primeiro uso).
  let firstActivation = false;
  if (hwid) {
    if (!record.hwid) {
      const expiresAt =
        record.durationDays > 0
          ? new Date(now + record.durationDays * 86400000).toISOString()
          : null;
      const activated = await activateHwidAtomic(key, hwid, expiresAt);
      if (!activated) {
        // Outro processo vinculou primeiro -> HWID_MISMATCH.
        const updated = await getKey(key);
        return {
          payload: {
            valid: false,
            code: VALIDATION_CODES.HWID_MISMATCH,
            message: 'Esta key ja esta vinculada a outro dispositivo.',
            key: updated ? updated.key : record.key,
            model: updated ? updated.model : record.model,
            plan: updated ? updated.plan : record.plan,
            durationDays: updated ? updated.durationDays : record.durationDays,
            activatedAt: updated ? updated.activatedAt : record.activatedAt,
            expiresAt: updated ? updated.expiresAt : record.expiresAt,
            daysLeft: updated ? daysLeftOf(updated, now) : daysLeftOf(record, now),
            hwidBound: true,
            checkedAt: nowIso(),
          },
          dirty: false,
        };
      }
      firstActivation = true;
      Object.assign(record, {
        hwid,
        activatedAt: new Date(now).toISOString(),
        expiresAt,
      });
    } else if (String(record.hwid).toUpperCase() !== hwid) {
      // Ja coberto por validateBusinessRules, mas mantido para seguranca.
      return fail(VALIDATION_CODES.HWID_MISMATCH, 'Esta key ja esta vinculada a outro HWID.', record, parsed, now);
    } else if (record.hwid !== hwid) {
      await updateKey(key, { hwid });
      record.hwid = hwid;
    }
  }

  // Incrementa uso e atualiza ultimo check (falha nao invalida a key).
  try {
    await updateKey(key, {
      lastCheckAt: new Date(now).toISOString(),
      uses: (record.uses || 0) + 1,
    });
  } catch (err) {
    // Falha ao atualizar uso/ultimo check nao deve invalida a key
    console.error('[repository] validateKey updateKey usage falhou:', err.message);
  }

  return {
    payload: successPayload(record, now, firstActivation),
    dirty: true,
  };
}

/* ------------------------------------------------------------------ *
 * Acoes administrativas sobre keys                                   *
 * ------------------------------------------------------------------ */

async function adminKeyAction(key, action, days) {
  const normalized = normalizeKey(key);
  const record = await getKey(normalized);
  if (!record) {
    throw httpError(404, 'Key nao encontrada.', { error: 'not_found' });
  }

  if (action === 'revoke') {
    await updateKey(normalized, { revoked: true });
  } else if (action === 'restore') {
    await updateKey(normalized, { revoked: false });
  } else if (action === 'reset') {
    await updateKey(normalized, { hwid: null, activatedAt: null, expiresAt: null, lastCheckAt: null, uses: 0 });
  } else if (action === 'delete') {
    await deleteKey(normalized);
    return { ok: true, key: serializeKey(record), action: 'delete' };
  } else if (action === 'extend') {
    const addDays = clampInt(days, 1, 3650, 30);
    record.durationDays += addDays;
    if (record.expiresAt) {
      record.expiresAt = new Date(Date.parse(record.expiresAt) + addDays * 86400000).toISOString();
    } else {
      record.expiresAt = new Date(Date.now() + addDays * 86400000).toISOString();
    }
    await updateKey(normalized, { durationDays: record.durationDays, expiresAt: record.expiresAt });
  } else {
    throw httpError(400, 'Acao invalida.', { error: 'invalid_action' });
  }

  const updated = await getKey(normalized);
  return { ok: true, key: serializeKey(updated), action };
}

function serializeKey(item) {
  const now = Date.now();
  return {
    key: item.key,
    model: item.model || 'private',
    status: statusOf(item, now),
    durationDays: item.durationDays,
    plan: item.plan || 'standard',
    note: item.note || '',
    createdBy: item.createdBy,
    ip: item.ip || '',
    hwid: item.hwid || '',
    createdAt: item.createdAt,
    activatedAt: item.activatedAt,
    expiresAt: item.expiresAt,
    lastCheckAt: item.lastCheckAt,
    uses: item.uses || 0,
    revoked: Boolean(item.revoked),
    daysLeft: daysLeftOf(item, now),
  };
}

/* ------------------------------------------------------------------ *
 * Listagem paginada / filtros                                        *
 * ------------------------------------------------------------------ */

async function listKeys(url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(5, Number.parseInt(url.searchParams.get('pageSize') || '12', 10) || 12),
  );
  const status = String(url.searchParams.get('status') || 'all');
  const modelFilter = String(url.searchParams.get('model') || 'all');
  const search = String(url.searchParams.get('search') || '').trim().toLowerCase();

  const items = await getKeys(); // ja ordenado por created_at desc

  let rows = items;
  if (status !== 'all') {
    rows = rows.filter((item) => statusOf(item) === status);
  }
  if (modelFilter !== 'all') {
    rows = rows.filter((item) => (item.model || 'private') === modelFilter);
  }
  if (search) {
    rows = rows.filter((item) => {
      const haystack = [item.key, item.model, item.hwid, item.ip, item.note]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    });
  }

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  const pageItems = rows.slice(start, start + pageSize).map(serializeKey);

  return { items: pageItems, total, page: safePage, pages, pageSize };
}

/* ------------------------------------------------------------------ *
 * Estatisticas e metricas                                            *
 * ------------------------------------------------------------------ */

async function computeStats() {
  const now = Date.now();
  const todayStart = startOfToday();
  const items = await getKeys();
  const stats = {
    total: 0,
    unused: 0,
    active: 0,
    expired: 0,
    revoked: 0,
    generatedToday: 0,
    validationsToday: 0,
    uniqueIps: 0,
    byModel: { private: 0, headtrick: 0, internal: 0 },
  };
  const ips = new Set();

  for (const item of items) {
    stats.total += 1;
    stats[statusOf(item, now)] += 1;
    if (stats.byModel[item.model] !== undefined) stats.byModel[item.model] += 1;
    if (Date.parse(item.createdAt || 0) >= todayStart) stats.generatedToday += 1;
    if (item.ip) ips.add(item.ip);
  }

  const today = dayKey();
  const result = await check(
    await supabase.from('metrics').select('*').eq('day_key', today).maybeSingle(),
    'computeStats metrics'
  );
  const row = result.data;
  stats.validationsToday = row ? row.validations || 0 : 0;
  stats.uniqueIps = ips.size;
  return stats;
}

async function chartData(days = 7) {
  const out = [];
  const today = dayKey();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startKey = dayKey(startDate);

  const result = await check(
    await supabase
      .from('metrics')
      .select('*')
      .gte('day_key', startKey)
      .lte('day_key', today)
      .order('day_key', { ascending: true }),
    'chartData'
  );
  const byDay = {};
  for (const row of result.data || []) byDay[row.day_key] = row;

  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = dayKey(date);
    const row = byDay[key] || { generated: 0, validations: 0 };
    out.push({
      date: key,
      label: date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''),
      generated: row.generated || 0,
      validations: row.validations || 0,
    });
  }
  return out;
}

async function publicStats() {
  const stats = await computeStats();
  return {
    totalKeys: stats.total,
    activeKeys: stats.active,
    generatedToday: stats.generatedToday,
    validationsToday: stats.validationsToday,
    byModel: stats.byModel,
  };
}

async function bumpMetric(field) {
  const today = dayKey();
  const result = await check(
    await supabase.from('metrics').select('*').eq('day_key', today).maybeSingle(),
    'bumpMetric select'
  );
  const row = result.data;

  const generated = field === 'generated' ? 1 : 0;
  const validations = field === 'validations' ? 1 : 0;

  if (!row) {
    await check(
      await supabase
        .from('metrics')
        .insert({ day_key: today, generated, validations }),
      'bumpMetric insert'
    );
  } else {
    await check(
      await supabase
        .from('metrics')
        .update({
          generated: (row.generated || 0) + generated,
          validations: (row.validations || 0) + validations,
        })
        .eq('day_key', today),
      'bumpMetric update'
    );
  }

  // Mantem apenas os ultimos MAX_METRICS_DAYS dias.
  const cutoff = dayKey(new Date(Date.now() - MAX_METRICS_DAYS * 86400000));
  await check(
    await supabase.from('metrics').delete().lt('day_key', cutoff),
    'bumpMetric prune'
  );
}

/* ------------------------------------------------------------------ *
 * Logs                                                               *
 * ------------------------------------------------------------------ */

async function addLog(type, { ip = '', key = '', detail = '' } = {}) {
  const id = require('node:crypto').randomBytes(6).toString('hex');
  await check(
    await supabase.from('logs').insert({ id, ts: nowIso(), type, ip, key, detail }),
    'addLog'
  );
  // Mantem apenas os ultimos MAX_LOGS logs.
  await pruneLogs();
}

async function pruneLogs() {
  const { data: oldIds } = await check(
    await supabase
      .from('logs')
      .select('id')
      .order('ts', { ascending: true }),
    'pruneLogs select'
  );
  const ids = (oldIds || []).map((r) => r.id);
  if (ids.length > MAX_LOGS) {
    const toDelete = ids.slice(0, ids.length - MAX_LOGS);
    await check(
      await supabase.from('logs').delete().in('id', toDelete),
      'pruneLogs delete'
    );
  }
}

async function getLogs({ type = 'all', limit = 120 } = {}) {
  let query = supabase.from('logs').select('*').order('ts', { ascending: false });
  if (type !== 'all') query = query.eq('type', type);
  const result = await check(await query, 'getLogs');
  const rows = result.data || [];
  const clamp = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 120));
  return rows.slice(0, clamp);
}

/* ------------------------------------------------------------------ *
 * Export                                                             *
 * ------------------------------------------------------------------ */

async function exportKeys() {
  const items = await getKeys(); // ja ordenado por created_at desc
  return items.map(serializeKey);
}

module.exports = {
  init,
  getBootGeneratedPassword,
  getConfig,
  getConfigRow,
  publicConfig,
  clientConfig,
  settingsPayload,
  updateConfig,
  getKeys,
  getKey,
  getKeysByIpAndSource,
  createKey,
  addKey,
  updateKey,
  activateHwidAtomic,
  deleteKey,
  validateKey,
  adminKeyAction,
  serializeKey,
  listKeys,
  computeStats,
  chartData,
  publicStats,
  bumpMetric,
  addLog,
  getLogs,
  exportKeys,
  VALIDATION_CODES,
};
