'use strict';

const { createClient } = require('@supabase/supabase-js');

function normalizeSupabaseUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  // Aceita tambem a URL do dashboard copiada do navegador:
  // https://supabase.com/dashboard/project/<project-ref>
  const dashboardMatch = raw.match(
    /https?:\/\/(?:app\.)?supabase\.com\/dashboard\/project\/([^/?#]+)/i,
  );
  if (dashboardMatch) return `https://${dashboardMatch[1]}.supabase.co`;

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(
      '[supabase] SUPABASE_URL invalida. Use https://<project-ref>.supabase.co.',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(
      '[supabase] SUPABASE_URL invalida. Use https://<project-ref>.supabase.co.',
    );
  }
  // O SDK adiciona /rest/v1 sozinho. Remover qualquer caminho evita
  // URLs duplicadas quando a URL REST foi copiada por engano.
  return `${parsed.protocol}//${parsed.host}`;
}

const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    '[supabase] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios. '
    + 'Copie .env.example para .env e preencha antes de iniciar.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabase };
