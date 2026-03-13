# PontoFácil

Sistema de auditoria do 1º ponto de técnicos de campo.

---

## Como subir online (Railway — grátis)

### 1. Pré-requisito
Crie uma conta gratuita em https://railway.app  
Instale o Git se não tiver: https://git-scm.com

### 2. Suba o projeto para o GitHub
```bash
# Na pasta pontofacil:
git init
git add .
git commit -m "PontoFacil v1"
```
- Crie um repositório novo em https://github.com/new (pode ser privado)
- Siga as instruções do GitHub para fazer o push

### 3. Deploy no Railway
1. Acesse https://railway.app → New Project → Deploy from GitHub repo
2. Selecione o repositório `pontofacil`
3. Railway detecta o Node.js automaticamente e sobe o app
4. Vá em **Settings → Networking → Generate Domain** para ter uma URL pública

Pronto. O app fica online 24h, acessível por qualquer pessoa com o link.

---

## Como adicionar/remover usuários

Abra o arquivo `server.js` e edite o array `USERS`:

```js
const USERS = [
  {
    id: 1,
    name: 'Vitor',
    username: 'vitor',
    passwordHash: bcrypt.hashSync('SUA_SENHA_AQUI', 10),
    role: 'admin',   // admin: pode fazer upload
  },
  {
    id: 2,
    name: 'Coordenador',
    username: 'coordenador',
    passwordHash: bcrypt.hashSync('SENHA_AQUI', 10),
    role: 'viewer',  // viewer: só visualiza
  },
];
```

Após editar, faça um novo commit e push — o Railway detecta e redeploya automaticamente.

---

## Como trocar a senha de sessão

No `server.js`, localize a linha:
```js
secret: process.env.SESSION_SECRET || 'pontofacil-secret-2026',
```

No Railway, vá em **Variables** e adicione:
```
SESSION_SECRET = qualquer_string_aleatoria_longa
```

---

## Fluxo de uso diário

1. **Admin** faz login → vê tela de upload
2. Exporta os 3 relatórios (PontoMais, Produção, Serviços) e faz upload
3. Clica em **Processar e Publicar**
4. Os dados ficam disponíveis no servidor para todos os usuários logados
5. **Viewers** fazem login e veem o dashboard diretamente

---

## Estrutura do projeto

```
pontofacil/
├── server.js       ← Servidor Node.js (auth, upload, processamento)
├── package.json    ← Dependências
├── public/
│   └── index.html  ← Frontend completo (login + dashboard)
└── README.md
```
