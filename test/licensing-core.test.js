'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const { canonicalUtc } = require('../lib/repository');
const { validateBusinessRules } = require('../lib/util');

const now = Date.parse('2026-10-29T12:00:00.000Z');
const expires = new Date(now + 24 * 60 * 60 * 1000).toISOString();
const record = {
  key: 'INTERNAL-ABCD-EFGH',
  model: 'internal',
  plan: 'standard',
  durationDays: 1,
  revoked: false,
  hwid: 'STABLE-HWID-01',
  activatedAt: '2026-10-29T12:00:00.000Z',
  expiresAt: expires,
};

assert.equal(canonicalUtc('2026-10-30T12:00:00.000+00:00'), '2026-10-30T12:00:00.000Z');
assert.equal(canonicalUtc('2026-10-30T12:00:00.000Z'), '2026-10-30T12:00:00.000Z');

assert.equal(validateBusinessRules(record, 'stable-hwid-01', 'internal', now), null);
assert.equal(validateBusinessRules(record, 'OTHER-HWID-02', 'internal', now).payload.code, 'HWID_MISMATCH');
assert.equal(validateBusinessRules(record, 'STABLE-HWID-01', 'private', now).payload.code, 'PRODUCT_MISMATCH');
assert.equal(validateBusinessRules(record, 'STABLE-HWID-01', 'internal', now + 24 * 60 * 60 * 1000).payload.code, 'EXPIRED');

console.log('licensing-core: timestamps UTC, HWID idempotente, produto e expiracao validados');
