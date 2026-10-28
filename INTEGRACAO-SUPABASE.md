# LEGION — Integração com Supabase (PostgreSQL)

O site em `C:\Users\SnyX\Documents\INTERNAL TESTE\LEGION` agora grava/le todos os dados (keys, configuração, logs e métricas) no **Supabase** em vez do arquivo `data/db.json`. A API pública (`/api/validate`, `/api/generate`, `/api/config`, `/api/stats`) e o painel (`/admin`) continuam exatamente iguais — o front-end **não precisa ser alterado**.

---

## 1. Criar o projeto no Supabase

1. Acesse https://app.supabase.com e crie um projeto (ou use um existente).
2. Vá em **Settings → API** e copie:
   - **Project URL** → `SUPABASE_URL`
   - **service_role secret** → `SUPABASE_SERVICE_ROLE_KEY` (chave de serviço, usada apenas no servidor)

> Use a `service_role` no servidor porque o LEGION é um sistema de chave único e o servidor é o único cliente. Se quiser expor o front-end diretamente ao Supabase, ative RLS nas tabelas.

---

## 2. Criar o banco (tabelas)

No painel do Supabase, abra o **SQL Editor** e rode todo o conteúdo do arquivo:

```
supabase-schema.sql
```

Isso cria as tabelas `keys`, `config`, `logs` e `metrics` com os índices necessários.

---

## 3. Configurar variáveis de ambiente

Copie o exemplo:

```powershell
# PowerShell (Windows)
copy .env.example .env
```

Edite `.env`:

```env
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-chave-de-servico

PORT=3000
HOST=0.0.0.0

# Senha admin usada apenas no primeiro boot (depois fica no Supabase)
ADMIN_PASSWORD=sua-senha-forte-aqui

TRUST_PROXY=0
```

- `TRUST_PROXY=1` apenas se o servidor ficar atrás de Nginx/Cloudflare/Render (para ler o IP real).

---

## 4. Instalar dependências

Pela primeira vez é necessário instalar os pacotes:

```powershell
cd "C:\Users\SnyX\Documents\INTERNAL TESTE\LEGION"
npm install
```

Isso instala `@supabase/supabase-js` e `dotenv`.

---

## 5. Migrar dados existentes (opcional)

Se já tem `data/db.json` com keys geradas, migre para o Supabase antes de rodar:

```powershell
npm run migrate:supabase
```

O script lê `data/db.json` e insere configuração, keys, logs e métricas no Supabase. O arquivo original **não é apagado**.

---

## 6. Rodar o servidor

```powershell
node server.js
```

Ou em modo de desenvolvimento (reinicia automaticamente ao salvar):

```powershell
npm run dev
```

Saída esperada:

```
  LEGION KEY SYSTEM  v1.1.0 (Supabase)
  ---------------------------------------------------
  Site     : http://localhost:3000
  Painel   : http://localhost:3000/admin
  Validacao: http://localhost:3000/api/validate
  Banco    : Supabase (PostgreSQL)

  SENHA ADMIN GERADA: xxxxxxxxxxxx
  Guarde agora. Troque no painel em Configuracoes > Seguranca.
```

Acesse `http://localhost:3000/admin` com a senha gerada (ou a do `ADMIN_PASSWORD`).

---

## 7. Subir em produção

O servidor precisa apenas de:
- Node.js 18+
- As variáveis de ambiente definidas
- Acesso de saída à internet (para alcançar o Supabase)

Exemplos de deploy: **Render, Railway, VPS, Fly.io**. Não é necessário volume de disco persistente para dados (agora estão no Supabase), embora seja útil para logs do sistema.

Se usar Nginx na frente, configure `proxy_pass` para `http://127.0.0.1:3000` e defina `TRUST_PROXY=1` + headers `X-Forwarded-For` / `X-Forwarded-Proto`. Com HTTPS ativo, o cookie da sessão do painel recebe `Secure` automaticamente.

---

## 8. Estrutura após a integração

```
LEGION/
├── server.js             # HTTP, rotas e API (mesmos endpoints de antes)
├── package.json          # agora com @supabase/supabase-js + dotenv
├── .env.example          # modelo de variaveis de ambiente
├── .env                  # SUAS variaveis (nao comitar)
├── supabase-schema.sql   # SQL para criar as tabelas no Supabase
├── INTEGRACAO-SUPABASE.md # este arquivo
├── lib/
│   ├── supabase.js       # cliente Supabase (service role)
│   ├── util.js           # utilitarios puros (senha, key, validacao)
│   └── repository.js     # leitura/gravacao no Supabase (substitui db.json)
├── scripts/
│   └── migrate-to-supabase.js  # migracao de data/db.json -> Supabase
├── public/               # front-end inalterado (index.html, admin.html, app.js...)
└── data/
    └── db.json           # mantido apenas como backup/referencia
```

---

## 9. O que mudou e o que ficou igual

| Item | Antes (db.json) | Depois (Supabase) |
|------|-----------------|-------------------|
| Armazenamento | `data/db.json` (arquivo local) | Tabelas PostgreSQL no Supabase |
| Endpoints `/api/*` | Mesmos | Mesmos (sem alteração) |
| Painel `/admin` | Mesma tela e funções | Mesma tela e funções |
| Formato da key | `PRIVATE-XXXX-YYYY` | Igual |
| Sessão admin | Cookie `legion_sid` (memória) | Igual |
| Rate limits | Em memória | Igual |
| Export CSV | Sim | Sim |
| Backup | `cp data/db.json` | Backup via Supabase (pg_dump / console) |

---

## 10. Solução de problemas

**`Erro: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.`**
- Crie o `.env` a partir do `.env.example` e preencha os dois valores do painel do Supabase (Settings → API).

**Conexão recusada / tabela não encontrada**
- Rode o `supabase-schema.sql` no SQL Editor do Supabase antes de iniciar o servidor.

**Senha admin não funciona**
- No primeiro boot, a senha vem de `ADMIN_PASSWORD` ou é gerada no console. Depois disso, ela fica no Supabase. Troque pelo painel em **Configurações → Segurança**. Se perder, edite o campo `admin_password` na tabela `config` ou rode novamente com `ADMIN_PASSWORD`.

**Front-end não carrega `config.js`**
- O `/config.js` é gerado dinamicamente pelo servidor a partir da configuração no Supabase. Se aparecer vazio, verifique se a linha `id = 1` existe na tabela `config` (o schema insere automaticamente).
