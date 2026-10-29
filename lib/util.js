'use strict';

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (sem I, L, O, U)
const KEY_RX = /^([A-Z0-9]{2,16})-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})$/;
const HWID_RX = /^[A-Za-z0-9._:@{}# -]{4,128}$/;

// Códigos de negócio padronizados (única fonte da verdade para validação).
const VALIDATION_CODES = {
  VALID: 'VALID',
  INVALID: 'INVALID',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  ALREADY_USED: 'ALREADY_USED',
  PRODUCT_MISMATCH: 'PRODUCT_MISMATCH',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_FORMAT: 'INVALID_FORMAT',
  NOT_FOUND: 'NOT_FOUND',
  HWID_INVALID: 'HWID_INVALID',
  HWID_MISMATCH: 'HWID_MISMATCH',
  SERVER_ERROR: 'SERVER_ERROR',
};

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

function secondsUntilTomorrow() {
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((tomorrow.getTime() - Date.now()) / 1000));
}

function randomChars(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] & 31];
  return out;
}

function normalizeKey(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function parseKey(key) {
  const match = KEY_RX.exec(String(key));
  if (!match) return null;
  const model = MODELS.find((item) => item.prefix === match[1]);
  if (!model) return null;
  return { prefix: match[1], body: `${match[2]}${match[3]}`, model };
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

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, digest] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = crypto.scryptSync(String(password), salt);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function generatePassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 caracteres
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
    throw Object.assign(new Error('URL invalida.'), { status: 400, field: 'url' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error('A URL precisa comecar com http:// ou https://.'), { status: 400, field: 'url' });
  }
  if (parsed.search || parsed.hash) {
    throw Object.assign(new Error('Remova query string e hash da URL.'), { status: 400, field: 'url' });
  }
  return raw.replace(/\/+$/, '');
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

function modelsConfig(configModels) {
  const normalized = normalizeModels(configModels);
  return MODELS.map((model) => ({
    ...model,
    enabled: normalized[model.id] ? normalized[model.id].enabled !== false : true,
  }));
}

/**
 * Valida as regras de negócio de uma key contra um registro do banco.
 * Esta é a ÚNICA fonte de verdade para validação — gerador, painel e clientes
 * devem usar os mesmos critérios aqui.
 *
 * @param {object} record - Registro da key no banco (ou null se não existir)
 * @param {string} rawHwid - HWID informado pelo cliente (pode ser vazio)
 * @param {string} requestedModel - Modelo/produto solicitado na validação (opcional)
 * @param {number} now - Timestamp atual (injetável para testes)
 * @returns {object} { payload: { valid, code, message, ... }, dirty: boolean }
 */
function validateBusinessRules(record, rawHwid, requestedModel, now = Date.now()) {
  if (!record) {
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.NOT_FOUND,
        message: 'Key não encontrada.',
        key: null,
        model: null,
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

  if (record.revoked) {
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.REVOKED,
        message: 'Esta key foi revogada.',
        key: record.key,
        model: record.model,
        plan: record.plan,
        durationDays: record.durationDays,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        daysLeft: daysLeftOf(record, now),
        hwidBound: Boolean(record.hwid),
        checkedAt: nowIso(),
      },
      dirty: false,
    };
  }

  if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.EXPIRED,
        message: 'Esta key expirou.',
        key: record.key,
        model: record.model,
        plan: record.plan,
        durationDays: record.durationDays,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        daysLeft: 0,
        hwidBound: Boolean(record.hwid),
        checkedAt: nowIso(),
      },
      dirty: false,
    };
  }

  // Verifica se a key pertence ao produto/modelo solicitado (quando informado).
  if (requestedModel && record.model !== requestedModel) {
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.PRODUCT_MISMATCH,
        message: 'Esta key não pertence ao produto informado.',
        key: record.key,
        model: record.model,
        plan: record.plan,
        durationDays: record.durationDays,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        daysLeft: daysLeftOf(record, now),
        hwidBound: Boolean(record.hwid),
        checkedAt: nowIso(),
      },
      dirty: false,
    };
  }

  // Valida formato do HWID quando informado.
  if (rawHwid && !HWID_RX.test(rawHwid)) {
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.HWID_INVALID,
        message: 'HWID inválido.',
        key: record.key,
        model: record.model,
        plan: record.plan,
        durationDays: record.durationDays,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        daysLeft: daysLeftOf(record, now),
        hwidBound: Boolean(record.hwid),
        checkedAt: nowIso(),
      },
      dirty: false,
    };
  }

  // Key já vinculada a outro HWID.
  if (rawHwid && record.hwid && String(record.hwid).toUpperCase() !== String(rawHwid).toUpperCase()) {
    return {
      payload: {
        valid: false,
        code: VALIDATION_CODES.HWID_MISMATCH,
        message: 'Esta key já está vinculada a outro dispositivo.',
        key: record.key,
        model: record.model,
        plan: record.plan,
        durationDays: record.durationDays,
        activatedAt: record.activatedAt,
        expiresAt: record.expiresAt,
        daysLeft: daysLeftOf(record, now),
        hwidBound: true,
        checkedAt: nowIso(),
      },
      dirty: false,
    };
  }

  return null; // regras de negócio aprovadas
}

function successPayload(record, now, firstActivation = false) {
  return {
    valid: true,
    code: VALIDATION_CODES.VALID,
    message: 'Key válida.',
    key: record.key,
    model: record.model,
    plan: record.plan || 'standard',
    durationDays: record.durationDays,
    activatedAt: record.activatedAt || null,
    expiresAt: record.expiresAt || null,
    daysLeft: daysLeftOf(record, now),
    hwidBound: Boolean(record.hwid),
    firstActivation,
    checkedAt: nowIso(),
  };
}

module.exports = {
  ALPHABET,
  KEY_RX,
  HWID_RX,
  MODELS,
  MODEL_MAP,
  PUBLIC_DURATIONS,
  VALIDATION_CODES,
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
};
