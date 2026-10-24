#!/usr/bin/env node
/*
 * LEGION — Key System
 * Gerador público de keys + painel administrativo + API de validação.
 *
 * Runtime : Node.js >= 18 (sem dependências externas)
 * Arquivo : server.js
 * Target  : Windows / Linux / macOS — qualquer host com Node
 *
 * Persistência: data/db.json (escrita atômica via tmp + rename).
 * Variáveis: PORT, HOST, ADMIN_PASSWORD, TRUST_PROXY, LEGION_DATA_DIR
 */
'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.LEGION_DATA_DIR
  ? path.resolve(process.env.LEGION_DATA_DIR)
  : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (sem I, L, O, U)
const KEY_RX = /^([A-Z0-9]{2,16})-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})$/;
const HWID_RX = /^[A-Za-z0-9._:@{}# -]{4,128}$/;

const MODELS = [
  {
    id: 'private',
    prefix: 'PRIVATE',
    label: 'PRIVATE',
    color: '#a78bfa',
    description: 'Licença individual',
  },
  {
    id: 'headtrick',
    prefix: 'HEADTRICK',
    label: 'HEADTRICK',
    color: '#ff5a3d',
    description: 'Licença de equipe',
  },
  {
    id: 'internal',
    prefix: 'INTERNAL',
    label: 'INTERNAL',
    color: '#35e08c',
    description: 'Acesso interno',
  },
];
const MODEL_MAP = new Map(MODELS.map((model) => [model.id, model]));
const PUBLIC_DURATIONS = [1, 7, 30];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self' http: https:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/* ------------------------------------------------------------------ *
 * Estado
 * ------------------------------------------------------------------ */

function defaultConfig() {
  return {
    brand: 'LEGION',
    publicUrl: '',
    apiBase: '',
    models: {
      private: { enabled: true },
      headtrick: { enabled: true },
      internal: { enabled: true },
    },
    cooldownSeconds: 120,
    dailyLimit: 5,
    defaultDurationDays: 30,
    maintenance: false,
    adminPassword: null,
    createdAt: new Date().toISOString(),
  };
}

const db = {
  version: 1,
  config: defaultConfig(),
  keys: [],
  logs: [],
  metrics: { byDay: {} },
};

const sessions = new Map(); // token -> expiresAt (ms)
const buckets = new Map(); // rate-limit key -> { count, reset }

let bootGeneratedPassword = null;

/* ------------------------------------------------------------------ *
 * Utilidades gerais
 * ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function joinUrl(base, suffix) {
  const clean = trimSlash(base);
  return clean ? `${clean}${suffix}` : suffix;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'Corpo da requisição muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(httpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const header = req.headers['x-forwarded-for'];
    if (typeof header === 'string' && header.trim()) {
      return header.split(',')[0].trim().replace(/^::ffff:/, '');
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
  }
  return String(req.socket.remoteAddress || '0.0.0.0').replace(/^::ffff:/, '');
}

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const piece of raw.split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    out[piece.slice(0, index).trim()] = decodeURIComponent(piece.slice(index + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `legion_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'legion_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim() || null;
}

function rateLimit(bucketKey, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(bucketKey);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)) };
  }
  return { allowed: true, retryAfter: 0 };
}

function secondsUntilTomorrow() {
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((tomorrow.getTime() - Date.now()) / 1000));
}

/* ------------------------------------------------------------------ *
 * Senha e sessão
 * ------------------------------------------------------------------ */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, digest] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function generatePassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 caracteres
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isAuthenticated(req) {
  const token = bearerToken(req) || parseCookies(req).legion_sid;
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  // Renova sessões já pela metade.
  if (expiresAt - Date.now() < SESSION_TTL_MS / 2) {
    sessions.set(token, Date.now() + SESSION_TTL_MS);
  }
  return true;
}

function requireAdmin(req, res) {
  if (isAuthenticated(req)) return true;
  sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Sessão expirada. Entre novamente.' });
  return false;
}

/* ------------------------------------------------------------------ *
 * Persistência
 * ------------------------------------------------------------------ */

let saveChain = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_PATH}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, DB_PATH);
    })
    .catch((err) => {
      console.error('[db] falha ao salvar:', err.message);
    });
  return saveChain;
}

async function loadDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let parsed = null;
  try {
    parsed = JSON.parse(await fsp.readFile(DB_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`\n[db] Não foi possível ler ${DB_PATH}`);
      console.error(`     ${err.message}`);
      console.error('     Corrija ou mova o arquivo e inicie novamente.\n');
      process.exit(1);
    }
  }

  if (parsed) {
    db.version = parsed.version || 1;
    db.config = { ...defaultConfig(), ...(parsed.config || {}) };
    db.config.models = normalizeModels(db.config.models);
    db.keys = Array.isArray(parsed.keys) ? parsed.keys : [];
    db.logs = Array.isArray(parsed.logs) ? parsed.logs.slice(0, 1000) : [];
    const byDay = parsed.metrics && parsed.metrics.byDay;
    db.metrics = { byDay: byDay && typeof byDay === 'object' ? byDay : {} };

    for (const item of db.keys) {
      if (!item.model) {
        const found = MODELS.find((model) => item.key.startsWith(`${model.prefix}-`));
        item.model = found ? found.id : 'private';
      }
    }
  } else {
    db.config.models = normalizeModels(db.config.models);
  }

  if (!db.config.adminPassword) {
    bootGeneratedPassword = process.env.ADMIN_PASSWORD || generatePassword();
    db.config.adminPassword = hashPassword(bootGeneratedPassword);
    if (process.env.ADMIN_PASSWORD) bootGeneratedPassword = null;
  }

  await persist();
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

function randomChars(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] & 31];
  return out;
}

function normalizeModels(input) {
  const out = {};
  for (const model of MODELS) {
    out[model.id] = {
      enabled: !(input && input[model.id] && input[model.id].enabled === false),
    };
  }
  return out;
}

function modelsConfig() {
  return MODELS.map((model) => ({
    ...model,
    enabled: db.config.models[model.id]
      ? db.config.models[model.id].enabled !== false
      : true,
  }));
}

function createKey(model) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const body = randomChars(8);
    const key = `${model.prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
    if (!db.keys.some((item) => item.key === key)) return key;
  }
  throw httpError(500, 'Não foi possível gerar uma key única.');
}

function parseKey(key) {
  const match = KEY_RX.exec(String(key));
  if (!match) return null;
  const model = MODELS.find((item) => item.prefix === match[1]);
  if (!model) return null;
  return { prefix: match[1], body: `${match[2]}${match[3]}`, model };
}

function normalizeKey(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function statusOf(item, now = Date.now()) {
  if (item.revoked) return 'revoked';
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return 'expired';
  if (item.hwid) return 'active';
  return 'unused';
}

function daysLeftOf(item, now = Date.now()) {
  if (!item.expiresAt) return null;
  return Math.max(0, Math.ceil((Date.parse(item.expiresAt) - now) / 86400000));
}

/* ------------------------------------------------------------------ *
 * Logs e métricas
 * ------------------------------------------------------------------ */

function addLog(type, { ip = '', key = '', detail = '' } = {}) {
  db.logs.unshift({
    id: crypto.randomBytes(6).toString('hex'),
    ts: nowIso(),
    type,
    ip,
    key,
    detail,
  });
  if (db.logs.length > 1000) db.logs.length = 1000;
}

function bumpMetric(field) {
  const today = dayKey();
  const row = db.metrics.byDay[today] || { generated: 0, validations: 0 };
  row[field] = (row[field] || 0) + 1;
  db.metrics.byDay[today] = row;

  const keys = Object.keys(db.metrics.byDay).sort();
  while (keys.length > 90) {
    const oldest = keys.shift();
    delete db.metrics.byDay[oldest];
  }
}

/* ------------------------------------------------------------------ *
 * Estatísticas
 * ------------------------------------------------------------------ */

function computeStats() {
  const now = Date.now();
  const todayStart = startOfToday();
  const stats = {
    total: 0,
    unused: 0,
    active: 0,
    expired: 0,
    revoked: 0,
    generatedToday: 0,
    validationsToday: 0,
    uniqueIps: 0,
    byModel: {
      private: 0,
      headtrick: 0,
      internal: 0,
    },
  };
  const ips = new Set();

  for (const item of db.keys) {
    stats.total += 1;
    stats[statusOf(item, now)] += 1;
    if (stats.byModel[item.model] !== undefined) stats.byModel[item.model] += 1;
    if (Date.parse(item.createdAt) >= todayStart) stats.generatedToday += 1;
    if (item.ip) ips.add(item.ip);
  }

  const today = db.metrics.byDay[dayKey()];
  stats.validationsToday = today ? today.validations || 0 : 0;
  stats.uniqueIps = ips.size;
  return stats;
}

function chartData(days = 7) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = dayKey(date);
    const row = db.metrics.byDay[key] || { generated: 0, validations: 0 };
    out.push({
      date: key,
      label: date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''),
      generated: row.generated || 0,
      validations: row.validations || 0,
    });
  }
  return out;
}

function publicStats() {
  const stats = computeStats();
  return {
    totalKeys: stats.total,
    activeKeys: stats.active,
    generatedToday: stats.generatedToday,
    validationsToday: stats.validationsToday,
    byModel: stats.byModel,
  };
}

/* ------------------------------------------------------------------ *
 * Config pública
 * ------------------------------------------------------------------ */

function publicConfig() {
  const cfg = db.config;
  return {
    brand: cfg.brand,
    publicUrl: cfg.publicUrl,
    apiBase: cfg.apiBase,
    models: modelsConfig(),
    durations: PUBLIC_DURATIONS,
    cooldownSeconds: cfg.cooldownSeconds,
    dailyLimit: cfg.dailyLimit,
    defaultDurationDays: cfg.defaultDurationDays,
    maintenance: cfg.maintenance,
    version: VERSION,
    validationUrl: joinUrl(cfg.publicUrl, '/api/validate'),
  };
}

function clientConfig() {
  const cfg = db.config;
  return {
    brand: cfg.brand,
    apiBase: trimSlash(cfg.apiBase),
    publicUrl: trimSlash(cfg.publicUrl),
    models: modelsConfig(),
    durations: PUBLIC_DURATIONS,
    cooldownSeconds: cfg.cooldownSeconds,
    defaultDurationDays: cfg.defaultDurationDays,
    maintenance: cfg.maintenance,
    version: VERSION,
    validationUrl: joinUrl(cfg.publicUrl, '/api/validate'),
  };
}

/* ------------------------------------------------------------------ *
 * Geração e validação
 * ------------------------------------------------------------------ */

function activeWebKeysByIp(ip) {
  return db.keys.filter((item) => item.createdBy === 'web' && item.ip === ip);
}

async function handleGenerate(req, res) {
  const ip = clientIp(req);
  // Consome o corpo (mantém a conexão keep-alive saudável e lê o modelo).
  const body = await readJsonBody(req).catch(() => ({}));
  const limit = rateLimit(`generate:${ip}`, 15, 10 * 60 * 1000);
  if (!limit.allowed) {
    return sendJson(res, 429, {
      ok: false,
      code: 'rate_limited',
      message: 'Muitas tentativas. Aguarde alguns minutos.',
      retryAfter: limit.retryAfter,
    });
  }

  if (db.config.maintenance) {
    return sendJson(res, 503, {
      ok: false,
      code: 'maintenance',
      message: 'Sistema em manutenção. Tente novamente em instantes.',
    });
  }

  const modelId = String(body.model || 'private').trim().toLowerCase();
  const model = MODEL_MAP.get(modelId);
  if (!model) {
    return sendJson(res, 400, {
      ok: false,
      code: 'invalid_model',
      message: 'Modelo de key inválido.',
    });
  }
  if (db.config.models[model.id] && db.config.models[model.id].enabled === false) {
    return sendJson(res, 403, {
      ok: false,
      code: 'model_disabled',
      message: 'Este gerador está desativado no momento.',
    });
  }

  const cfg = db.config;
  const now = Date.now();
  const requestedDuration = body.durationDays;
  let durationDays = cfg.defaultDurationDays;

  if (requestedDuration !== undefined && requestedDuration !== null && requestedDuration !== '') {
    const parsedDuration = Number.parseInt(requestedDuration, 10);
    if (!PUBLIC_DURATIONS.includes(parsedDuration)) {
      return sendJson(res, 400, {
        ok: false,
        code: 'invalid_duration',
        message: 'Duração inválida. Escolha 1, 7 ou 30 dias.',
      });
    }
    durationDays = parsedDuration;
  } else if (!PUBLIC_DURATIONS.includes(durationDays)) {
    durationDays = 30;
  }

  const mine = activeWebKeysByIp(ip);
  const lastCreated = mine.reduce((acc, item) => Math.max(acc, Date.parse(item.createdAt) || 0), 0);

  if (cfg.cooldownSeconds > 0 && lastCreated && now - lastCreated < cfg.cooldownSeconds * 1000) {
    const retryAfter = Math.max(
      1,
      Math.ceil((cfg.cooldownSeconds * 1000 - (now - lastCreated)) / 1000),
    );
    return sendJson(res, 429, {
      ok: false,
      code: 'cooldown',
      message: `Aguarde ${retryAfter}s para gerar outra key.`,
      retryAfter,
      nextAt: new Date(lastCreated + cfg.cooldownSeconds * 1000).toISOString(),
    });
  }

  const todayStart = startOfToday();
  const createdToday = mine.filter((item) => Date.parse(item.createdAt) >= todayStart).length;
  if (cfg.dailyLimit > 0 && createdToday >= cfg.dailyLimit) {
    return sendJson(res, 429, {
      ok: false,
      code: 'daily_limit',
      message: 'Limite diário atingido. Volte amanhã.',
      retryAfter: secondsUntilTomorrow(),
    });
  }

  const key = createKey(model);
  const item = {
    key,
    model: model.id,
    createdAt: nowIso(),
    createdBy: 'web',
    ip,
    durationDays,
    plan: 'standard',
    note: '',
    revoked: false,
    hwid: null,
    activatedAt: null,
    expiresAt: null,
    lastCheckAt: null,
    uses: 0,
  };
  db.keys.push(item);
  bumpMetric('generated');
  addLog('generate', { ip, key, detail: `${model.prefix} · ${durationDays}d` });
  await persist();

  const remainingToday = cfg.dailyLimit > 0 ? Math.max(0, cfg.dailyLimit - createdToday - 1) : null;
  return sendJson(res, 201, {
    ok: true,
    key: item.key,
    model: item.model,
    prefix: model.prefix,
    durationDays: item.durationDays,
    createdAt: item.createdAt,
    remainingToday,
    cooldownSeconds: cfg.cooldownSeconds,
  });
}

function validateKey(rawKey, rawHwid) {
  const key = normalizeKey(rawKey);
  const hwid = String(rawHwid || '').trim();
  const now = Date.now();
  const parsed = parseKey(key);

  const fail = (code, message, record = null) => ({
    payload: {
      valid: false,
      code,
      message,
      key,
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
  });

  if (!parsed) {
    return fail('invalid_format', 'Formato de key inválido.');
  }

  const record = db.keys.find((item) => item.key === key);
  if (!record) return fail('not_found', 'Key não encontrada.');
  if (record.revoked) return fail('revoked', 'Esta key foi revogada.', record);
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
    return fail('expired', 'Esta key expirou.', record);
  }
  if (hwid && !HWID_RX.test(hwid)) return fail('hwid_invalid', 'HWID inválido.', record);

  let firstActivation = false;
  if (hwid) {
    if (!record.hwid) {
      record.hwid = hwid;
      record.activatedAt = new Date(now).toISOString();
      record.expiresAt =
        record.durationDays > 0
          ? new Date(now + record.durationDays * 86400000).toISOString()
          : null;
      firstActivation = true;
    } else if (record.hwid !== hwid) {
      return fail('hwid_mismatch', 'Esta key já está vinculada a outro HWID.', record);
    }
  }

  record.lastCheckAt = new Date(now).toISOString();
  record.uses = (record.uses || 0) + 1;

  return {
    payload: {
      valid: true,
      code: 'ok',
      message: 'Key válida.',
      key,
      model: record.model,
      plan: record.plan || 'standard',
      durationDays: record.durationDays,
      activatedAt: record.activatedAt || null,
      expiresAt: record.expiresAt || null,
      daysLeft: daysLeftOf(record, now),
      hwidBound: Boolean(record.hwid),
      firstActivation,
      checkedAt: record.lastCheckAt,
    },
    dirty: true,
  };
}

async function handleValidate(req, res, url) {
  const ip = clientIp(req);
  const limit = rateLimit(`validate:${ip}`, 120, 60 * 1000);
  if (!limit.allowed) {
    return sendJson(res, 429, {
      valid: false,
      code: 'rate_limited',
      message: 'Muitas validações. Aguarde um instante.',
      retryAfter: limit.retryAfter,
    });
  }

  let body;
  if (req.method === 'POST') {
    body = await readJsonBody(req);
  } else {
    body = {
      key: url.searchParams.get('key') || '',
      hwid: url.searchParams.get('hwid') || '',
    };
  }

  if (!body.key) {
    return sendJson(res, 400, {
      valid: false,
      code: 'missing_key',
      message: 'Informe a key.',
    });
  }

  const result = validateKey(body.key, body.hwid);
  if (result.dirty) {
    if (result.payload.valid) bumpMetric('validations');
    await persist();
  }
  addLog(result.payload.valid ? 'validate_ok' : 'validate_fail', {
    ip,
    key: normalizeKey(body.key),
    detail: result.payload.code,
  });

  return sendJson(res, 200, result.payload);
}

/* ------------------------------------------------------------------ *
 * Painel administrativo — dados
 * ------------------------------------------------------------------ */

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

function listKeys(url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(5, Number.parseInt(url.searchParams.get('pageSize') || '12', 10) || 12),
  );
  const status = String(url.searchParams.get('status') || 'all');
  const modelFilter = String(url.searchParams.get('model') || 'all');
  const search = String(url.searchParams.get('search') || '').trim().toLowerCase();

  let rows = db.keys.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

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
  const items = rows.slice(start, start + pageSize).map(serializeKey);

  return { items, total, page: safePage, pages, pageSize };
}

function settingsPayload() {
  const cfg = db.config;
  return {
    brand: cfg.brand,
    publicUrl: cfg.publicUrl,
    apiBase: cfg.apiBase,
    models: modelsConfig(),
    cooldownSeconds: cfg.cooldownSeconds,
    dailyLimit: cfg.dailyLimit,
    defaultDurationDays: cfg.defaultDurationDays,
    maintenance: cfg.maintenance,
    createdAt: cfg.createdAt,
    version: VERSION,
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(400, 'URL inválida.', { field: 'url' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw httpError(400, 'A URL precisa começar com http:// ou https://.', { field: 'url' });
  }
  if (parsed.search || parsed.hash) {
    throw httpError(400, 'Remova query string e hash da URL.', { field: 'url' });
  }
  return raw.replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ *
 * Painel administrativo — rotas
 * ------------------------------------------------------------------ */

async function handleAdmin(req, res, url) {
  const pathname = trimSlash(url.pathname);
  const method = req.method;
  const ip = clientIp(req);

  if (method === 'POST' && pathname === '/api/admin/login') {
    const limit = rateLimit(`login:${ip}`, 10, 10 * 60 * 1000);
    if (!limit.allowed) {
      return sendJson(res, 429, {
        ok: false,
        error: 'rate_limited',
        message: 'Muitas tentativas. Aguarde 10 minutos.',
        retryAfter: limit.retryAfter,
      });
    }
    const body = await readJsonBody(req);
    if (!verifyPassword(body.password, db.config.adminPassword)) {
      addLog('admin_login_fail', { ip, detail: 'senha incorreta' });
      await persist();
      return sendJson(res, 401, { ok: false, error: 'invalid_credentials', message: 'Senha incorreta.' });
    }
    const token = createSession();
    setSessionCookie(req, res, token);
    addLog('admin_login', { ip, detail: 'ok' });
    await persist();
    return sendJson(res, 200, {
      ok: true,
      token,
      expiresIn: Math.floor(SESSION_TTL_MS / 1000),
    });
  }

  if (method === 'POST' && pathname === '/api/admin/logout') {
    sessions.delete(bearerToken(req) || parseCookies(req).legion_sid);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (!requireAdmin(req, res)) return undefined;

  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers['x-legion'] !== 'panel') {
      return sendJson(res, 403, { ok: false, error: 'csrf', message: 'Requisição não autorizada.' });
    }
  }

  if (method === 'GET' && pathname === '/api/admin/me') {
    return sendJson(res, 200, {
      ok: true,
      authenticated: true,
      brand: db.config.brand,
      version: VERSION,
    });
  }

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const stats = computeStats();
    return sendJson(res, 200, {
      ok: true,
      stats,
      chart: chartData(7),
      recent: db.logs.slice(0, 6),
      config: settingsPayload(),
    });
  }

  if (method === 'GET' && pathname === '/api/admin/keys') {
    return sendJson(res, 200, { ok: true, ...listKeys(url) });
  }

  if (method === 'POST' && pathname === '/api/admin/keys') {
    const body = await readJsonBody(req);
    const modelId = String(body.model || 'private').trim().toLowerCase();
    const model = MODEL_MAP.get(modelId);
    if (!model) {
      return sendJson(res, 400, { ok: false, error: 'invalid_model', message: 'Modelo inválido.' });
    }
    const amount = clampInt(body.amount, 1, 100, 1);
    const durationDays = clampInt(body.durationDays, 0, 3650, db.config.defaultDurationDays);
    const note = String(body.note || '').slice(0, 120);
    const created = [];
    for (let i = 0; i < amount; i += 1) {
      const item = {
        key: createKey(model),
        model: model.id,
        createdAt: nowIso(),
        createdBy: 'admin',
        ip,
        durationDays,
        plan: 'standard',
        note,
        revoked: false,
        hwid: null,
        activatedAt: null,
        expiresAt: null,
        lastCheckAt: null,
        uses: 0,
      };
      db.keys.push(item);
      created.push(item.key);
      bumpMetric('generated');
    }
    addLog('admin_generate', {
      ip,
      detail: `${model.prefix} · ${amount} key(s), ${durationDays}d`,
    });
    await persist();
    return sendJson(res, 201, {
      ok: true,
      keys: created,
      model: model.id,
      prefix: model.prefix,
      amount,
      durationDays,
    });
  }

  if (method === 'POST' && pathname === '/api/admin/keys/action') {
    const body = await readJsonBody(req);
    const key = normalizeKey(body.key);
    const action = String(body.action || '');
    const record = db.keys.find((item) => item.key === key);
    if (!record) {
      return sendJson(res, 404, { ok: false, error: 'not_found', message: 'Key não encontrada.' });
    }

    if (action === 'revoke') {
      record.revoked = true;
      addLog('key_revoke', { ip, key, detail: record.note || '' });
    } else if (action === 'restore') {
      record.revoked = false;
      addLog('key_restore', { ip, key, detail: record.note || '' });
    } else if (action === 'reset') {
      record.hwid = null;
      record.activatedAt = null;
      record.expiresAt = null;
      record.lastCheckAt = null;
      record.uses = 0;
      addLog('key_reset', { ip, key, detail: 'hwid liberado' });
    } else if (action === 'delete') {
      db.keys = db.keys.filter((item) => item.key !== key);
      addLog('key_delete', { ip, key, detail: record.note || '' });
    } else if (action === 'extend') {
      const days = clampInt(body.days, 1, 3650, 30);
      record.durationDays += days;
      if (record.expiresAt) {
        record.expiresAt = new Date(Date.parse(record.expiresAt) + days * 86400000).toISOString();
      }
      addLog('key_extend', { ip, key, detail: `+${days}d` });
    } else {
      return sendJson(res, 400, { ok: false, error: 'invalid_action' });
    }

    await persist();
    return sendJson(res, 200, { ok: true, key: serializeKey(record) });
  }

  if (method === 'GET' && pathname === '/api/admin/export') {
    const rows = db.keys
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((item) => {
        const view = serializeKey(item);
        return [
          view.key,
          view.model,
          view.status,
          view.durationDays,
          view.hwid,
          view.ip,
          view.createdAt,
          view.activatedAt || '',
          view.expiresAt || '',
          view.lastCheckAt || '',
          view.uses,
          view.note,
        ];
      });
    const header = [
      'key',
      'modelo',
      'status',
      'dias',
      'hwid',
      'ip',
      'criada_em',
      'ativada_em',
      'expira_em',
      'ultimo_check',
      'usos',
      'nota',
    ];
    const csv = '\uFEFF' + [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="legion-keys-${dayKey()}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  if (method === 'GET' && pathname === '/api/admin/logs') {
    const type = String(url.searchParams.get('type') || 'all');
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 120);
    let rows = db.logs;
    if (type !== 'all') rows = rows.filter((item) => item.type === type);
    return sendJson(res, 200, { ok: true, items: rows.slice(0, limit) });
  }

  if (method === 'GET' && pathname === '/api/admin/settings') {
    return sendJson(res, 200, { ok: true, settings: settingsPayload() });
  }

  if (method === 'PUT' && pathname === '/api/admin/settings') {
    const body = await readJsonBody(req);
    const cfg = db.config;
    const next = {};

    if ('brand' in body) {
      const brand = String(body.brand || '').trim().toUpperCase();
      if (!/^[A-Z0-9 .-]{2,20}$/.test(brand)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_brand', message: 'Nome inválido.' });
      }
      next.brand = brand;
    }
    if ('publicUrl' in body) next.publicUrl = normalizeUrl(body.publicUrl);
    if ('apiBase' in body) next.apiBase = normalizeUrl(body.apiBase);
    if ('models' in body && body.models && typeof body.models === 'object') {
      const models = {};
      for (const model of MODELS) {
        const incoming = body.models[model.id];
        models[model.id] = {
          enabled: incoming
            ? incoming.enabled !== false
            : db.config.models[model.id].enabled !== false,
        };
      }
      next.models = models;
    }
    if ('cooldownSeconds' in body) next.cooldownSeconds = clampInt(body.cooldownSeconds, 0, 86400, cfg.cooldownSeconds);
    if ('dailyLimit' in body) next.dailyLimit = clampInt(body.dailyLimit, 0, 1000, cfg.dailyLimit);
    if ('defaultDurationDays' in body) {
      next.defaultDurationDays = clampInt(body.defaultDurationDays, 0, 3650, cfg.defaultDurationDays);
    }
    if ('maintenance' in body) next.maintenance = Boolean(body.maintenance);

    Object.assign(db.config, next);
    addLog('setting_update', {
      ip,
      detail: Object.keys(next)
        .map((key) => {
          const value = next[key];
          if (key === 'models') {
            return `models=${MODELS.map((model) => `${model.id}:${value[model.id].enabled ? 'on' : 'off'}`).join(',')}`;
          }
          if (typeof value === 'boolean') return `${key}=${value ? 'on' : 'off'}`;
          return `${key}=${value}`;
        })
        .join(' '),
    });
    await persist();
    return sendJson(res, 200, { ok: true, settings: settingsPayload() });
  }

  if (method === 'POST' && pathname === '/api/admin/password') {
    const body = await readJsonBody(req);
    if (!verifyPassword(body.current, db.config.adminPassword)) {
      return sendJson(res, 401, { ok: false, error: 'invalid_password', message: 'Senha atual incorreta.' });
    }
    const next = String(body.next || '');
    if (next.length < 8) {
      return sendJson(res, 400, { ok: false, error: 'weak_password', message: 'A nova senha precisa ter 8+ caracteres.' });
    }
    db.config.adminPassword = hashPassword(next);
    sessions.clear();
    const token = createSession();
    setSessionCookie(req, res, token);
    addLog('password_change', { ip, detail: 'ok' });
    await persist();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/check-url') {
    const body = await readJsonBody(req);
    let target;
    try {
      target = normalizeUrl(body.url);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_url', message: 'URL inválida.' });
    }
    if (!target) {
      return sendJson(res, 400, { ok: false, error: 'invalid_url', message: 'Informe uma URL.' });
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`${target}/api/health`, {
        signal: controller.signal,
        headers: { 'User-Agent': `Legion/${VERSION}` },
      });
      const latencyMs = Date.now() - started;
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      addLog('url_check', { ip, detail: `${target} → ${response.status}` });
      await persist();
      return sendJson(res, 200, {
        ok: response.ok && Boolean(payload && payload.ok),
        status: response.status,
        latencyMs,
        payload,
      });
    } catch (err) {
      return sendJson(res, 200, {
        ok: false,
        status: 0,
        error: err.name === 'AbortError' ? 'timeout' : err.message,
        message: 'Não foi possível alcançar a URL.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
}

/* ------------------------------------------------------------------ *
 * API pública
 * ------------------------------------------------------------------ */

async function handlePublicApi(req, res, url) {
  const pathname = trimSlash(url.pathname);
  const ip = clientIp(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'legion',
      version: VERSION,
      uptime: Math.floor(process.uptime()),
      time: nowIso(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const limit = rateLimit(`config:${ip}`, 240, 60 * 1000);
    if (!limit.allowed) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    return sendJson(res, 200, publicConfig());
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    const limit = rateLimit(`stats:${ip}`, 120, 60 * 1000);
    if (!limit.allowed) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    return sendJson(res, 200, { ok: true, ...publicStats() });
  }

  if (req.method === 'POST' && pathname === '/api/generate') {
    return handleGenerate(req, res);
  }

  if ((req.method === 'POST' || req.method === 'GET') && pathname === '/api/validate') {
    return handleValidate(req, res, url);
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
}

/* ------------------------------------------------------------------ *
 * Arquivos estáticos
 * ------------------------------------------------------------------ */

function sendConfigJs(res) {
  const body = `/* gerado dinamicamente pelo servidor LEGION */\nwindow.LEGION_CONFIG = ${JSON.stringify(
    clientConfig(),
  )};\n`;
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  if (pathname === '/config.js') return sendConfigJs(res);
  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/admin' || pathname === '/admin/' || pathname === '/painel') {
    pathname = '/admin.html';
  } else if (pathname === '/favicon.ico') {
    pathname = '/favicon.svg';
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch {
    return sendText(res, 404, 'Not Found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';
  const revalidate = isHtml || ext === '.js' || ext === '.css';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ------------------------------------------------------------------ *
 * Servidor
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/admin')) {
      await handleAdmin(req, res, url);
    } else if (url.pathname.startsWith('/api/')) {
      await handlePublicApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err.status || 500;
    if (status >= 500) console.error('[server]', err);
    sendJson(res, status, {
      ok: false,
      error: err.code || (status >= 500 ? 'internal_error' : 'bad_request'),
      message: status >= 500 ? 'Erro interno.' : err.message,
    });
  }
});

async function main() {
  await loadDb();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[legion] A porta ${PORT} já está em uso. Use PORT=outra_porta.\n`);
      process.exit(1);
    }
    console.error('[legion] erro no servidor:', err);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log('');
    console.log(`  LEGION KEY SYSTEM  v${VERSION}`);
    console.log(`  ---------------------------------------------------`);
    console.log(`  Site     : http://${shownHost}:${PORT}`);
    console.log(`  Painel   : http://${shownHost}:${PORT}/admin`);
    console.log(`  Validação: http://${shownHost}:${PORT}/api/validate`);
    console.log(`  Dados    : ${DB_PATH}`);
    if (bootGeneratedPassword) {
      console.log('');
      console.log(`  SENHA ADMIN GERADA: ${bootGeneratedPassword}`);
      console.log('  Guarde agora. Troque no painel em Configurações > Segurança.');
    }
    console.log('');
  });

  setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(token);
    }
    for (const [key, bucket] of buckets) {
      if (bucket.reset <= now) buckets.delete(key);
    }
  }, 60 * 1000).unref();

  const shutdown = (signal) => {
    console.log(`\n[legion] ${signal} recebido, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[legion] falha ao iniciar:', err);
  process.exit(1);
});
