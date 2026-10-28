/* LEGION — testes automatizados do sistema de keys
 * Testa os endpoints da API contra o servidor local.
 * Execute: node test/validate.test.js
 * Preconditions: servidor rodando em http://localhost:3000
 */

'use strict';

const http = require('node:http');

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
const errors = [];

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    errors.push(message);
    console.log(`  ✗ ${message}`);
  }
}

async function testHealth() {
  console.log('\n[1] GET /api/health');
  const r = await request('GET', '/api/health').catch((e) => ({ status: 0, body: { error: e.message } }));
  assert(r.status === 200, 'retorna HTTP 200');
  assert(r.body.ok === true || r.body.ok === false, 'possui campo ok');
  assert(typeof r.body.version === 'string', 'possui versão');
  console.log(`    corpo: ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function testConfig() {
  console.log('\n[2] GET /api/config');
  const r = await request('GET', '/api/config').catch((e) => ({ status: 0, body: { error: e.message } }));
  assert(r.status === 200, 'retorna HTTP 200');
  assert(Array.isArray(r.body.models), 'possui lista de modelos');
  assert(typeof r.body.cooldownSeconds === 'number', 'possui cooldownSeconds');
  assert(typeof r.body.dailyLimit === 'number', 'possui dailyLimit');
  console.log(`    modelos: ${r.body.models.map((m) => `${m.id}:${m.enabled}`).join(', ')}`);
  console.log(`    cooldown: ${r.body.cooldownSeconds}s, dailyLimit: ${r.body.dailyLimit}`);
}

async function testValidateMissingKey() {
  console.log('\n[3] GET /api/validate (sem key)');
  const r = await request('GET', '/api/validate').catch((e) => ({ status: 0, body: { error: e.message } }));
  assert(r.status === 400, 'retorna HTTP 400');
  assert(r.body.valid === false, 'valid é false');
  assert(r.body.code === 'MISSING_KEY', `código MISSING_KEY (recebido: ${r.body.code})`);
  console.log(`    corpo: ${JSON.stringify(r.body)}`);
}

async function testValidateInvalidFormat() {
  console.log('\n[4] GET /api/validate (formato invalido)');
  const r = await request('GET', '/api/validate?key=INVALIDO&hwid=TEST').catch((e) => ({ status: 0, body: { error: e.message } }));
  assert(r.status === 200, 'retorna HTTP 200');
  assert(r.body.valid === false, 'valid é false');
  assert(r.body.code === 'INVALID_FORMAT', `código INVALID_FORMAT (recebido: ${r.body.code})`);
  console.log(`    corpo: ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function testValidateNotFound() {
  console.log('\n[5] GET /api/validate (key inexistente)');
  const r = await request('GET', '/api/validate?key=INTERNAL-AAAA-BBBB&hwid=TEST1234').catch((e) => ({ status: 0, body: { error: e.message } }));
  assert(r.status === 200, 'retorna HTTP 200');
  assert(r.body.valid === false, 'valid é false');
  assert(r.body.code === 'NOT_FOUND', `código NOT_FOUND (recebido: ${r.body.code})`);
  console.log(`    corpo: ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function testValidateProductMismatch() {
  console.log('\n[6] GET /api/validate (modelo diferente)');
  const r = await request('GET', '/api/validate?key=PRIVATE-AAAA-BBBB&hwid=TEST1234&model=internal').catch((e) => ({ status: 0, body: { error: e.message } }));
  // Pode ser NOT_FOUND (key nao existe) ou PRODUCT_MISMATCH (se existir)
  assert(r.status === 200, 'retorna HTTP 200');
  assert(r.body.valid === false, 'valid é false');
  console.log(`    corpo: ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function testGenerate() {
  console.log('\n[7] POST /api/generate');
  try {
    const r = await request('POST', '/api/generate', {
      model: 'internal',
      durationDays: 30,
    });
    assert(r.status === 201 || r.status === 429 || r.status === 503, 'retorna HTTP 201/429/503');
    if (r.status === 201) {
      assert(r.body.ok === true, 'ok é true');
      assert(typeof r.body.key === 'string' && r.body.key.length > 0, 'gera uma key');
      console.log(`    key gerada: ${r.body.key}`);
    } else if (r.status === 429) {
      console.log(`    rate-limited: ${r.body.message || r.body.code}`);
    } else if (r.status === 503) {
      console.log(`    manutencao: ${r.body.message || r.body.code}`);
    }
  } catch (e) {
    console.log(`    erro na requisicao: ${e.message}`);
  }
}

async function main() {
  console.log('========================================');
  console.log('  LEGION — Testes automatizados');
  console.log('========================================');
  console.log(`  Servidor: ${BASE}`);

  await testHealth();
  await testConfig();
  await testValidateMissingKey();
  await testValidateInvalidFormat();
  await testValidateNotFound();
  await testValidateProductMismatch();
  await testGenerate();

  console.log('\n========================================');
  console.log(`  Resultado: ${passed} passou, ${failed} falhou`);
  console.log('========================================');

  if (errors.length > 0) {
    console.log('\nFalhas:');
    errors.forEach((e) => console.log(`  - ${e}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erro fatal nos testes:', err);
  process.exit(1);
});
