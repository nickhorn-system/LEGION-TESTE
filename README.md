# LEGION — Key System

Gerador de keys com **3 modelos** e duração de **1, 7 ou 30 dias**, painel administrativo e API de validação. Zero dependências: roda em qualquer lugar com Node.js 18+.

```
site público  →  escolhe PRIVATE / HEADTRICK / INTERNAL + 1/7/30 dias  →  gera a key
painel        →  gerencia, revoga, filtra e valida
loader        →  POST /api/validate
```

## Modelos

| modelo | prefixo | formato da key | uso |
|---|---|---|---|
| PRIVATE | `PRIVATE` | `PRIVATE-X7K9-P2QM` | licença individual |
| HEADTRICK | `HEADTRICK` | `HEADTRICK-X7K9-P2QM` | licença de equipe |
| INTERNAL | `INTERNAL` | `INTERNAL-X7K9-P2QM` | acesso interno |

Os três aparecem no site como cards selecionáveis. Cada key nasce com o prefixo do modelo escolhido; a validação devolve o modelo no JSON.

---

## 1. Rodar local

```bash
node server.js
```

Sem `npm install` — não existe dependência externa.

Na primeira execução o servidor cria `data/db.json` e imprime a senha administrativa no console:

```
  LEGION KEY SYSTEM  v1.0.0
  ---------------------------------------------------
  Site     : http://localhost:3000
  Painel   : http://localhost:3000/admin
  Validação: http://localhost:3000/api/validate
  Dados    : .../data/db.json

  SENHA ADMIN GERADA: xxxxxxxxxxxx
  Guarde agora. Troque no painel em Configurações > Segurança.
```

Para definir a senha já no primeiro boot:

```bash
# Windows (PowerShell)
$env:ADMIN_PASSWORD="sua-senha-forte"; node server.js

# Linux / macOS
ADMIN_PASSWORD="sua-senha-forte" node server.js
```

Depois do primeiro boot, `ADMIN_PASSWORD` deixa de ser usada — a senha vive na tabela `config` do Supabase (hash scrypt). Troque pelo painel.

### Variáveis de ambiente

| variável | padrão | função |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `HOST` | `0.0.0.0` | interface de escuta |
| `ADMIN_PASSWORD` | — | senha inicial (só primeiro boot) |
| `TRUST_PROXY` | `0` | `1` atrás de Nginx/Cloudflare/Render para ler o IP real |
| `SUPABASE_URL` | — | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | — | chave privada usada somente pelo servidor |

---

## 2. Colocar online e trocar a URL

A URL se troca **pelo painel**, sem editar código e sem reiniciar.

1. Rode o schema `supabase-schema.sql` no SQL Editor do Supabase.
2. Suba o servidor (Render, Railway, VPS, Fly.io…). Os dados ficam no Supabase; não é necessário volume persistente.
3. Abra `https://seu-dominio.com/admin` e entre com a senha.
4. Vá em **Configurações → Site & API**.
5. Preencha **URL pública do site** com `https://seu-dominio.com` (sem barra no final).
6. Clique em **Testar conexão** e depois em **Salvar alterações**.

A partir daí o endpoint exibido no painel, no site e nos exemplos de integração passa a ser `https://seu-dominio.com/api/validate`.

**URL base da API (opcional):** use só se o front ficar em um domínio diferente da API (ex.: site na Vercel, API na VPS). O valor seria `https://api.seu-dominio.com`.

Config salva na tabela `config` do Supabase:

```json
{
  "config": {
    "publicUrl": "https://seu-dominio.com",
    "apiBase": "",
    "models": {
      "private": { "enabled": true },
      "headtrick": { "enabled": true },
      "internal": { "enabled": true }
    }
  }
}
```

---

## 3. Deploy

### Render / Railway

- Build: `npm install`.
- Start: `node server.js`.
- Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `ADMIN_PASSWORD` como variáveis secretas.
- `TRUST_PROXY=1`.
- `ADMIN_PASSWORD` apenas no primeiro deploy.

### VPS (Ubuntu + Nginx)

```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# app
sudo mkdir -p /opt/legion && sudo chown $USER /opt/legion
# copie os arquivos para /opt/legion
cd /opt/legion
ADMIN_PASSWORD='senha-forte' node server.js   # teste rápido

# systemd
sudo tee /etc/systemd/system/legion.service > /dev/null <<'EOF'
[Unit]
Description=LEGION Key System
After=network.target

[Service]
WorkingDirectory=/opt/legion
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000
Environment=TRUST_PROXY=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now legion
```

Nginx:

```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Depois: `sudo certbot --nginx -d seu-dominio.com`. Com HTTPS ativo, o cookie de sessão do painel ganha `Secure` automaticamente quando `X-Forwarded-Proto: https` chega.

---

## 4. API de validação

### `POST /api/validate`

```bash
curl -X POST "https://seu-dominio.com/api/validate" \
  -H "Content-Type: application/json" \
  -d '{"key":"INTERNAL-X7K9-P2QM","hwid":"ABC123"}'
```

Resposta válida:

```json
{
  "valid": true,
  "code": "ok",
  "message": "Key válida.",
  "key": "INTERNAL-X7K9-P2QM",
  "model": "internal",
  "plan": "standard",
  "durationDays": 30,
  "activatedAt": "2026-10-24T15:02:11.000Z",
  "expiresAt": "2026-11-23T15:02:11.000Z",
  "daysLeft": 30,
  "hwidBound": true,
  "firstActivation": true,
  "checkedAt": "2026-10-24T15:02:11.000Z"
}
```

Resposta inválida:

```json
{
  "valid": false,
  "code": "hwid_mismatch",
  "message": "Esta key já está vinculada a outro HWID.",
  "key": "INTERNAL-X7K9-P2QM",
  "model": "internal",
  "daysLeft": 27,
  "hwidBound": true,
  "checkedAt": "2026-10-24T15:05:00.000Z"
}
```

### Códigos

| code | significado |
|---|---|
| `ok` | key válida |
| `missing_key` | corpo sem `key` |
| `invalid_format` | formato ou prefixo inválido |
| `not_found` | key não existe no banco |
| `revoked` | revogada pelo painel |
| `expired` | passou da validade |
| `hwid_invalid` | HWID fora do padrão `[A-Za-z0-9._:@{}# -]{4,128}` |
| `hwid_mismatch` | já vinculada a outro HWID |
| `rate_limited` | muitas chamadas por minuto |
| `maintenance` | geração pausada |
| `invalid_model` | modelo desconhecido no `/api/generate` |
| `model_disabled` | modelo pausado no painel |
| `invalid_duration` | duração fora de 1, 7 ou 30 dias no `/api/generate` |

Regras:

- `hwid` é opcional. Sem HWID a key só é consultada; com HWID ela é **ativada e vinculada** no primeiro uso.
- A validade conta a partir da **ativação**, não da criação.
- No site público a duração é **1, 7 ou 30 dias**. No painel o admin ainda pode criar key vitalícia (`0`) ou com validade personalizada.
- CORS liberado (`Access-Control-Allow-Origin: *`).
- Limite: 120 validações/minuto por IP.

### `POST /api/generate`

```bash
curl -X POST "https://seu-dominio.com/api/generate" \
  -H "Content-Type: application/json" \
  -d '{"model":"private","durationDays":7}'
```

`model` aceita `private`, `headtrick` ou `internal` (padrão `private`).
`durationDays` aceita **1, 7 ou 30** (padrão: o configurado no painel, limitado a essas opções). Resposta:

```json
{
  "ok": true,
  "key": "PRIVATE-R9GW-THVV",
  "model": "private",
  "prefix": "PRIVATE",
  "durationDays": 7,
  "createdAt": "2026-10-24T15:00:00.000Z",
  "remainingToday": 4,
  "cooldownSeconds": 120
}
```

### Outros endpoints públicos

| método | rota | função |
|---|---|---|
| GET | `/api/health` | status + versão |
| GET | `/api/config` | brand, URLs, modelos, durações e limites |
| GET | `/api/stats` | contadores + `byModel` |
| GET | `/api/validate?key=...&hwid=...` | validação por query string |

---

## 5. Painel

- **Visão geral** — totais, resumo por modelo, gráfico de 7 dias, distribuição por status, atividade recente, endpoint público.
- **Keys** — busca por key/modelo/HWID/IP/nota, filtro por status e por modelo, copiar, revogar/reativar, liberar HWID, excluir, CSV.
- **Gerar keys** — modelo, lote de 1–100, validade e nota interna.
- **Validação** — URL do endpoint, testador de key + HWID e exemplos em cURL / JavaScript / C# / Python.
- **Configurações** — URL pública, URL da API, cooldown, limite diário, validade, modelos ativos, manutenção e troca de senha.
- **Logs** — últimos 1.000 eventos.

Sessão: cookie `HttpOnly` + `SameSite=Lax`, 12 horas, token de 256 bits em memória. Reiniciar o servidor derruba as sessões.

---

## 6. Formato da key

```
INTERNAL-X7K9-P2QM
   │      │    └── 4 caracteres aleatórios
   │      └─────── 4 caracteres aleatórios
   └────────────── prefixo do modelo
```

- Alfabeto Crockford base32 (sem `I`, `L`, `O`, `U`).
- 8 caracteres aleatórios = 40 bits de entropia por key.
- O prefixo precisa ser `PRIVATE`, `HEADTRICK` ou `INTERNAL`; qualquer outro cai em `invalid_format`.
- A autoridade é o banco: keys bem formadas que não existem em `data/db.json` retornam `not_found`.
- Pausar um modelo no painel **não invalida** keys já geradas; só impede novas gerações daquele modelo.

---

## 7. Backup e dados

Tudo vive em `data/db.json` (keys, config, logs, métricas), escrito de forma atômica (`tmp` + `rename`).

```bash
cp data/db.json backup-$(date +%F).json
```

- Não apague `data/` em produção.
- O arquivo contém o hash da senha; trate como credencial.
- Keys não dependem de segredo externo: restaurar o `db.json` restaura a validação.

---

## 8. Segurança

- Troque a senha no primeiro acesso.
- Use HTTPS em produção.
- Defina `TRUST_PROXY=1` apenas quando houver proxy na frente.
- Rate limits: geração 15/10 min por IP, validação 120/min, login 10/10 min.
- CSRF: rotas administrativas de escrita exigem o header `X-Legion: panel` além do cookie `SameSite=Lax`.
- Não existe recuperação de senha: se perder, edite `config.adminPassword` no `db.json` ou apague a chave e reinicie com `ADMIN_PASSWORD`.
- O painel não deve ser exposto em domínio separado sem HTTPS.

---

## 9. Estrutura

```
LEGION/
├── server.js            # HTTP, API, auth, storage (zero deps)
├── package.json
├── public/
│   ├── index.html       # gerador público com 3 modelos
│   ├── admin.html       # painel
│   ├── styles.css       # tema completo
│   ├── app.js           # lógica do gerador
│   ├── admin.js         # lógica do painel
│   └── favicon.svg
├── data/
│   └── db.json          # criado no primeiro boot
└── README.md
```

---

## 10. Personalização rápida

| o quê | onde |
|---|---|
| ativar/pausar modelos | Configurações → Modelos |
| cooldown / limite diário / validade | Configurações → Keygen |
| URL pública | Configurações → Site & API |
| cores | `public/styles.css` → bloco `:root` |
| textos do site | `public/index.html` |
| textos do painel | `public/admin.html` + `public/admin.js` |

Os prefixos e as cores dos modelos ficam em `server.js` (`MODELS`) e nos cards de `public/index.html` / `public/admin.html`.
