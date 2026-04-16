# Ideale Instagram Planner — Agency Pro v8.5

Ferramente estratégica de planejamento de Instagram para agências, com **IA multi-modelo** (Groq + Gemini), **Spy de concorrentes via Playwright**, **calendário editorial**, **gerador de hashtags** e **dashboard de métricas reais** via Instagram Graph API.

---

## 🚀 Deploy no Render

Este projeto está configurado para deploy via **Docker no Render**. O arquivo `render.yaml` define toda a infraestrutura.

1. Fork/clone este repositório para o seu GitHub.
2. No Render, crie um novo Web Service a partir do GitHub e selecione este repositório.
3. Configure as variáveis de ambiente abaixo (o `render.yaml` já define as chaves).

---

## ⚙️ Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha:

| Variável | Descrição |
|---|---|
| `PORT` | Porta local (padrão: `3000`) |
| `SESSION_SECRET` | String longa aleatória para segurança de sessão (`openssl rand -base64 64`) |
| `BASE_URL` | URL pública do app (ex: `https://meu-app.onrender.com`) |
| `NODE_ENV` | `development` ou `production` |
| `GROQ_API_KEY` | Chave da API Groq — [console.groq.com/keys](https://console.groq.com/keys) |
| `GEMINI_API_KEY` | Chave da API Gemini — [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `IG_TOKENS` | Tokens de acesso longos do Instagram, separados por vírgula |
| `SAMBANOVA_API_KEY` | Chave SambaNova Cloud (fallback) — [cloud.sambanova.ai](https://cloud.sambanova.ai) |
| `MONGODB_URI` | String de conexão MongoDB Atlas — [cloud.mongodb.com](https://cloud.mongodb.com) |

---

## 🖥️ Executar Localmente

```bash
npm install
npx playwright install chromium
npm start
```

Acesse `http://localhost:3000`.

---

## 🧠 Funcionalidades

- **Planejador de Conteúdo com IA** — 4 semanas de funil estratégico (Atenção → Autoridade → Conexão → Conversão)
- **Spy de Concorrentes** — análise via Playwright stealth com Vision AI
- **Bio 3D** — 3 variações (Autoridade, Conexão, Conversão) geradas por IA
- **Calendário Editorial** — visualização e agendamento de posts
- **Gerador de Hashtags** — sugestões estratégicas por nicho
- **Dashboard de Métricas** — dados reais da Instagram Graph API
- **Scripts de Reels** — roteiros com ganchos e CTAs fortes
- **Simulador de Objeções** — preparação para vendas via DM
- **Fallback de IA Quádruplo** — Groq → Gemini → fallback automático

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express |
| IA Principal | Groq (llama-3.3-70b-versatile) |
| IA Secundária | Google Gemini 2.5 Flash |
| Scraping | Playwright (Chromium headless) |
| API Social | Instagram Graph API |
| Sessões | express-session + memorystore |
| Segurança | helmet + express-rate-limit |
| Deploy | Docker + Render |
| Frontend | HTML5 + CSS + JavaScript Vanilla |

---

## 📁 Estrutura do Projeto

```
instagram-planner/
├── server.js              # Backend principal (Express + todas as rotas)
├── package.json
├── Dockerfile
├── render.yaml            # Configuração de deploy no Render
├── .env.example           # Template de variáveis de ambiente
├── .gitignore
├── api/
│   └── competitors        # Módulo de spy de concorrentes
├── data/
│   └── clients/
│       └── default.json   # Perfil padrão de cliente
└── public/
    ├── index.html         # Login / entrada
    ├── app.html           # Interface principal da ferramenta
    ├── dashboard.html     # Dashboard de métricas
    └── privacy.html       # Política de privacidade
```

---

## 📄 Licença

MIT — uso livre para agências e freelancers.
