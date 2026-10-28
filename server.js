#!/usr/bin/env node
/*
 * LEGION — Key System (com Supabase)
 * Gerador publico de keys + painel administrativo + API de validacao.
 *
 * Runtime : Node.js >= 18
 * Arquivo : server.js
 * Target  : Windows / Linux / macOS
 *
 * Persistencia: Supabase (PostgreSQL) via lib/repository.js
 *   Rode supabase-schema.sql no Editor SQL do Supabase antes de iniciar.
 *   Copie .env.example para .env e preencha SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
 *
 * Variaveis: PORT, HOST, ADMIN_PASSWORD, TRUST_PROXY, LEGION_DATA_DIR (ignorado agora)
 */

'use strict';

require('dotenv').config();

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const repository = require('./lib/repository');
const {
  verifyPassword,
  hashPassword,
  generatePassword,
  MODELS,
  MODEL_MAP,
  normalizeKey,
  PUBLIC_DURATIONS,
} = require('./lib/util');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

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
  '.exe': 'application/octet-stream',
  '.dll': 'application/octet-stream',
  '.zip': 'application/zip',
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
 * Estado em memoria (sessoes e rate-limit nao vao para o Supabase)   *
 * ------------------------------------------------------------------ */

const sessions = new Map(); // token -> expiresAt (ms)
const buckets = new Map(); // rate-limit key -> { count, reset }

/* ------------------------------------------------------------------ *
 * Utilidades HTTP                                                    *
 * ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
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
        reject(httpError(413, 'Corpo da requisicao muito grande.'));
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
        reject(httpError(400, 'JSON invalido.'));
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
 * Sessao e autenticacao                                              *
 * ------------------------------------------------------------------ */

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
  if (expiresAt - Date.now() < SESSION_TTL_MS / 2) {
    sessions.set(token, Date.now() + SESSION_TTL_MS);
  }
  return true;
}

function requireAdmin(req, res) {
  if (isAuthenticated(req)) return true;
  sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Sessao expirada. Entre novamente.' });
  return false;
}

/* ------------------------------------------------------------------ *
 * Arquivos estaticos                                                 *
 * ------------------------------------------------------------------ */

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function joinUrl(base, suffix) {
  const clean = trimSlash(base);
  return clean ? `${clean}${suffix}` : suffix;
}

async function sendConfigJs(res) {
  const config = await repository.getConfig();
  const body =
    `/* gerado dinamicamente pelo servidor LEGION */\nwindow.LEGION_CONFIG = ${JSON.stringify(
      repository.clientConfig(config),
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
  } else if (pathname === '/download' || pathname === '/download/') {
    pathname = '/download.html';
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
  const isDownloadFile = pathname.startsWith('/download/');

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
    'Content-Disposition': isDownloadFile
      ? `attachment; filename="${path.basename(filePath)}"`
      : 'inline',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ------------------------------------------------------------------ *
 * Geração de keys (publico)                                          *
 * ------------------------------------------------------------------ */

async function handleGenerate(req, res) {
  const ip = clientIp(req);
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

  const config = await repository.getConfig();
  const cfg = config.config;

  if (cfg.maintenance) {
    return sendJson(res, 503, {
      ok: false,
      code: 'maintenance',
      message: 'Sistema em manutencao. Tente novamente em instantes.',
    });
  }

  const modelId = String(body.model || 'private').trim().toLowerCase();
  const model = MODEL_MAP.get(modelId);
  if (!model) {
    return sendJson(res, 400, {
      ok: false,
      code: 'invalid_model',
      message: 'Modelo de key invalido.',
    });
  }
  if (cfg.models[model.id] && cfg.models[model.id].enabled === false) {
    return sendJson(res, 403, {
      ok: false,
      code: 'model_disabled',
      message: 'Este gerador esta desativado no momento.',
    });
  }

  const requestedDuration = body.durationDays;
  let durationDays = cfg.defaultDurationDays;
  if (
    requestedDuration !== undefined &&
    requestedDuration !== null &&
    requestedDuration !== ''
  ) {
    const parsedDuration = Number.parseInt(requestedDuration, 10);
    if (!PUBLIC_DURATIONS.includes(parsedDuration)) {
      return sendJson(res, 400, {
        ok: false,
        code: 'invalid_duration',
        message: 'Duracao invalida. Escolha 1, 7 ou 30 dias.',
      });
    }
    durationDays = parsedDuration;
  } else if (!PUBLIC_DURATIONS.includes(durationDays)) {
    durationDays = 30;
  }

  const mine = await repository.getKeysByIpAndSource(ip, 'web');
  const now = Date.now();
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

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const createdToday = mine.filter((item) => Date.parse(item.createdAt) >= todayStart).length;
  if (cfg.dailyLimit > 0 && createdToday >= cfg.dailyLimit) {
    return sendJson(res, 429, {
      ok: false,
      code: 'daily_limit',
      message: 'Limite diario atingido. Volte amanha.',
      retryAfter: secondsUntilTomorrow(),
    });
  }

  const key = await repository.createKey(model.id);
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
  await repository.addKey(item);
  await repository.bumpMetric('generated');
  await repository.addLog('generate', { ip, key, detail: `${model.prefix} · ${durationDays}d` });

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

/* ------------------------------------------------------------------ *
 * Validacao de key (publico)                                         *
 * ------------------------------------------------------------------ */

async function handleValidate(req, res, url) {
  const ip = clientIp(req);
  const limit = rateLimit(`validate:${ip}`, 120, 60 * 1000);
  if (!limit.allowed) {
    return sendJson(res, 429, {
      valid: false,
      code: 'rate_limited',
      message: 'Muitas validacoes. Aguarde um instante.',
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

  const result = await repository.validateKey(body.key, body.hwid);
  if (result.dirty) {
    if (result.payload.valid) await repository.bumpMetric('validations');
  }
  await repository.addLog(result.payload.valid ? 'validate_ok' : 'validate_fail', {
    ip,
    key: normalizeKey(body.key),
    detail: result.payload.code,
  });

  return sendJson(res, 200, result.payload);
}

/* ------------------------------------------------------------------ *
 * Painel administrativo — dados                                      *
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
    const config = await repository.getConfig();
    if (!verifyPassword(body.password, config.config.adminPassword)) {
      await repository.addLog('admin_login_fail', { ip, detail: 'senha incorreta' });
      return sendJson(res, 401, {
        ok: false,
        error: 'invalid_credentials',
        message: 'Senha incorreta.',
      });
    }
    const token = createSession();
    setSessionCookie(req, res, token);
    await repository.addLog('admin_login', { ip, detail: 'ok' });
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
      return sendJson(res, 403, { ok: false, error: 'csrf', message: 'Requisicao nao autorizada.' });
    }
  }

  if (method === 'GET' && pathname === '/api/admin/me') {
    const config = await repository.getConfig();
    return sendJson(res, 200, {
      ok: true,
      authenticated: true,
      brand: config.config.brand,
      version: VERSION,
    });
  }

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const [stats, chart, recent, config] = await Promise.all([
      repository.computeStats(),
      repository.chartData(7),
      repository.getLogs({ limit: 6 }),
      repository.getConfig(),
    ]);
    return sendJson(res, 200, {
      ok: true,
      stats,
      chart,
      recent,
      config: repository.settingsPayload(config),
    });
  }

  if (method === 'GET' && pathname === '/api/admin/keys') {
    const result = await repository.listKeys(url);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (method === 'POST' && pathname === '/api/admin/keys') {
    const body = await readJsonBody(req);
    const modelId = String(body.model || 'private').trim().toLowerCase();
    const model = MODEL_MAP.get(modelId);
    if (!model) {
      return sendJson(res, 400, { ok: false, error: 'invalid_model', message: 'Modelo invalido.' });
    }
    const config = await repository.getConfig();
    const cfg = config.config;
    const amount = clampInt(body.amount, 1, 100, 1);
    const durationDays = clampInt(
      body.durationDays,
      0,
      3650,
      cfg.defaultDurationDays,
    );
    const note = String(body.note || '').slice(0, 120);
    const created = [];
    const nowIsoLocal = nowIso();
    for (let i = 0; i < amount; i += 1) {
      const key = await repository.createKey(model.id);
      const item = {
        key,
        model: model.id,
        createdAt: nowIsoLocal,
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
      await repository.addKey(item);
      created.push(key);
      await repository.bumpMetric('generated');
    }
    await repository.addLog('admin_generate', {
      ip,
      detail: `${model.prefix} · ${amount} key(s), ${durationDays}d`,
    });
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
    const days = body.days;
    const result = await repository.adminKeyAction(key, action, days);
    return sendJson(res, 200, { ok: true, key: result.key });
  }

  if (method === 'GET' && pathname === '/api/admin/export') {
    const rows = await repository.exportKeys();
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
    const csv =
      '\uFEFF' +
      [header, ...rows]
        .map((row) =>
          row
            .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
            .join(','),
        )
        .join('\r\n');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="legion-keys-${y}-${m}-${d}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  if (method === 'GET' && pathname === '/api/admin/logs') {
    const type = String(url.searchParams.get('type') || 'all');
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 120);
    const items = await repository.getLogs({ type, limit });
    return sendJson(res, 200, { ok: true, items });
  }

  if (method === 'GET' && pathname === '/api/admin/settings') {
    const config = await repository.getConfig();
    return sendJson(res, 200, { ok: true, settings: repository.settingsPayload(config) });
  }

  if (method === 'PUT' && pathname === '/api/admin/settings') {
    const body = await readJsonBody(req);
    const config = await repository.updateConfig(body);
    await repository.addLog('setting_update', {
      ip,
      detail: Object.keys(body)
        .map((k) => {
          const v = body[k];
          if (k === 'models') {
            return `models=${MODELS.map((m) => `${m.id}:${v && v[m.id] ? 'on' : 'off'}`).join(',')}`;
          }
          if (typeof v === 'boolean') return `${k}=${v ? 'on' : 'off'}`;
          return `${k}=${v}`;
        })
        .join(' '),
    });
    return sendJson(res, 200, { ok: true, settings: repository.settingsPayload(config) });
  }

  if (method === 'POST' && pathname === '/api/admin/password') {
    const body = await readJsonBody(req);
    const config = await repository.getConfig();
    if (!verifyPassword(body.current, config.config.adminPassword)) {
      return sendJson(res, 401, {
        ok: false,
        error: 'invalid_password',
        message: 'Senha atual incorreta.',
      });
    }
    const next = String(body.next || '');
    if (next.length < 8) {
      return sendJson(res, 400, {
        ok: false,
        error: 'weak_password',
        message: 'A nova senha precisa ter 8+ caracteres.',
      });
    }
    const config2 = await repository.updateConfig({ adminPassword: hashPassword(next) });
    sessions.clear();
    const token = createSession();
    setSessionCookie(req, res, token);
    await repository.addLog('password_change', { ip, detail: 'ok' });
    return sendJson(res, 200, { ok: true, settings: repository.settingsPayload(config2) });
  }

  if (method === 'POST' && pathname === '/api/admin/check-url') {
    const body = await readJsonBody(req);
    let target;
    try {
      target = normalizeUrl(body.url);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_url', message: 'URL invalida.' });
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
      await repository.addLog('url_check', { ip, detail: `${target} → ${response.status}` });
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
        message: 'Nao foi possivel alcançar a URL.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
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
    throw httpError(400, 'URL invalida.', { field: 'url' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw httpError(400, 'A URL precisa comecar com http:// ou https://.', { field: 'url' });
  }
  if (parsed.search || parsed.hash) {
    throw httpError(400, 'Remova query string e hash da URL.', { field: 'url' });
  }
  return raw.replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ *
 * API publica                                                        *
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
    let supabaseOk = false;
    let supabaseError = null;
    try {
      const { data, error } = await supabase.from('config').select('id').limit(1);
      supabaseOk = !error;
      supabaseError = error ? error.message : null;
    } catch (e) {
      supabaseError = e.message;
    }
    return sendJson(res, 200, {
      ok: supabaseOk,
      service: 'legion',
      version: VERSION,
      uptime: Math.floor(process.uptime()),
      time: nowIso(),
      supabase: supabaseOk ? 'ok' : 'error',
      supabaseError: supabaseError || null,
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const limit = rateLimit(`config:${ip}`, 240, 60 * 1000);
    if (!limit.allowed) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    const config = await repository.getConfig();
    return sendJson(res, 200, repository.publicConfig(config));
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    const limit = rateLimit(`stats:${ip}`, 120, 60 * 1000);
    if (!limit.allowed) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    return sendJson(res, 200, { ok: true, ...(await repository.publicStats()) });
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
 * Servidor                                                           *
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
  const { config, bootGeneratedPassword } = await repository.init();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[legion] A porta ${PORT} ja esta em uso. Use PORT=outra_porta.\n`);
      process.exit(1);
    }
    console.error('[legion] erro no servidor:', err);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log('');
    console.log(`  LEGION KEY SYSTEM  v${VERSION} (Supabase)`);
    console.log(`  ---------------------------------------------------`);
    console.log(`  Site     : http://${shownHost}:${PORT}`);
    console.log(`  Painel   : http://${shownHost}:${PORT}/admin`);
    console.log(`  Validacao: http://${shownHost}:${PORT}/api/validate`);
    console.log(`  Banco    : Supabase (PostgreSQL)`);
    if (bootGeneratedPassword) {
      console.log('');
      console.log(`  SENHA ADMIN GERADA: ${bootGeneratedPassword}`);
      console.log('  Guarde agora. Troque no painel em Configuracoes > Seguranca.');
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
