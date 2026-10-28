#!/usr/bin/env node
/*
 * scripts/migrate-to-supabase.js
 * Migra os dados de data/db.json (JSON local) para o Supabase.
 *
 * Uso:
 *   1. Copie .env.example para .env e preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
 *   2. Rode supabase-schema.sql no Editor SQL do Supabase.
 *   3. node scripts/migrate-to-supabase.js
 *
 * Insere/configuracao, keys, logs e metricas. Nao apaga o db.json original.
 */

'use strict';

require('dotenv').config();
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { hashPassword } = require('../lib/util');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Erro: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

async function main() {
  let db;
  try {
    db = JSON.parse(await fsp.readFile(DB_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`Nenhum ${DB_PATH} encontrado. Nada para migrar.`);
      return;
    }
    throw err;
  }

  const config = (db && db.config) || {};
  const keys = Array.isArray(db.keys) ? db.keys : [];
  const logs = Array.isArray(db.logs) ? db.logs : [];
  const byDay = (db.metrics && db.metrics.byDay) || {};

  console.log(`Lido ${DB_PATH}: ${keys.length} key(s), ${logs.length} log(s), ${Object.keys(byDay).length} dia(s) de metrica.`);

  // 1. Configuracao (linha unica id = 1)
  const models = config.models || { private: { enabled: true }, headtrick: { enabled: true }, internal: { enabled: true } };
  const adminPassword = config.adminPassword || null;

  const { error: cfgErr } = await supabase.from('config').upsert({
    id: 1,
    brand: config.brand || 'LEGION',
    public_url: config.publicUrl || '',
    api_base: config.apiBase || '',
    models,
    cooldown_seconds: config.cooldownSeconds ?? 120,
    daily_limit: config.dailyLimit ?? 5,
    default_duration_days: config.defaultDurationDays ?? 30,
    maintenance: Boolean(config.maintenance),
    admin_password: adminPassword,
  }, { onConflict: 'id' });
  if (cfgErr) throw cfgErr;
  console.log('Configuracao migrada.');

  // 2. Keys (insercao em lotes de 500)
  const rows = keys.map((k) => ({
    key: k.key,
    model: k.model || 'private',
    duration_days: k.durationDays ?? 30,
    plan: k.plan || 'standard',
    note: k.note || '',
    created_by: k.createdBy || 'web',
    ip: k.ip || null,
    hwid: k.hwid || null,
    created_at: k.createdAt,
    activated_at: k.activatedAt || null,
    expires_at: k.expiresAt || null,
    last_check_at: k.lastCheckAt || null,
    uses: k.uses ?? 0,
    revoked: Boolean(k.revoked),
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('keys').insert(batch);
    if (error) throw error;
  }
  console.log(`${rows.length} key(s) migrada(s).`);

  // 3. Logs (ultimos 1000)
  const logsToInsert = logs.slice(-1000).map((l) => ({
    id: l.id || require('node:crypto').randomBytes(6).toString('hex'),
    ts: l.ts,
    type: l.type,
    ip: l.ip || '',
    key: l.key || null,
    detail: l.detail || '',
  }));
  if (logsToInsert.length) {
    const { error } = await supabase.from('logs').insert(logsToInsert);
    if (error) throw error;
  }
  console.log(`${logsToInsert.length} log(s) migrado(s).`);

  // 4. Metricas por dia
  const metricRows = Object.entries(byDay).map(([dayKey, v]) => ({
    day_key: dayKey,
    generated: (v && v.generated) || 0,
    validations: (v && v.validations) || 0,
  }));
  if (metricRows.length) {
    const { error } = await supabase.from('metrics').insert(metricRows);
    if (error) throw error;
  }
  console.log(`${metricRows.length} linha(s) de metrica migrada(s).`);

  // 5. Senha admin: se nao houver hash no Supabase e houver ADMIN_PASSWORD no .env, define.
  const { data: cfg } = await supabase.from('config').select('admin_password').eq('id', 1).single();
  if (!cfg.admin_password && process.env.ADMIN_PASSWORD) {
    const { error } = await supabase
      .from('config')
      .update({ admin_password: hashPassword(process.env.ADMIN_PASSWORD) })
      .eq('id', 1);
    if (error) throw error;
    console.log('Senha admin definida via ADMIN_PASSWORD.');
  }

  console.log('\nMigracao concluida com sucesso!');
  console.log('Agora rode: node server.js');
}

main().catch((err) => {
  console.error('Falha na migracao:', err);
  process.exit(1);
});
