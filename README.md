# Instagram Marketing Planner — Deploy no Render

## Passo a Passo Completo

### 1. Subir no GitHub

```bash
cd instagram-planner
git init
git add .
git commit -m "feat: instagram planner v2 com meta api"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/instagram-planner.git
git push -u origin main
```

### 2. Configurar no Meta for Developers

1. Acesse https://developers.facebook.com/apps/
2. Selecione seu app (ID: 1748220689689304)
3. Vá em **Configurações → Básico**
4. Em **Domínios do App**, adicione: `seu-app.onrender.com`
5. Vá em **Facebook Login → Configurações**
6. Em **URIs de redirecionamento OAuth válidos**, adicione:
   ```
   https://seu-app.onrender.com/auth/callback
   ```
7. Salve as alterações

### 3. Deploy no Render

1. Acesse https://render.com e crie uma conta gratuita
2. Clique em **New → Web Service**
3. Conecte seu repositório GitHub
4. Configure:
   - **Name**: instagram-marketing-planner
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

5. Adicione as **Environment Variables**:

| Variável | Valor |
|----------|-------|
| `FB_APP_ID` | `1748220689689304` |
| `FB_APP_SECRET` | `6c5421fc9134212b96096e5a4b6f5eb8` |
| `SESSION_SECRET` | `meta-ads-meu-segredo-2024-xpto` |
| `GROQ_API_KEY` | sua chave gratuita em **console.groq.com** |
| `BASE_URL` | `https://seu-app.onrender.com` (preencha após criar o serviço) |
| `NODE_ENV` | `production` |

6. Clique em **Create Web Service**
7. Aguarde o deploy (2-3 minutos)
8. Copie a URL gerada (ex: `https://instagram-planner-abc123.onrender.com`)
9. **Volte à variável `BASE_URL` e atualize com a URL real**
10. **Volte ao Meta for Developers e adicione a URL real no OAuth**

### 4. Obter Chave Groq (100% Gratuito)

1. Acesse https://console.groq.com
2. Crie uma conta gratuita (sem cartão de crédito)
3. Vá em **API Keys → Create API Key**
4. Copie e cole em `GROQ_API_KEY` no Render
5. Modelo usado: **llama-3.3-70b-versatile** — rápido e poderoso

### 5. Permissões do App Meta (Importante)

Para que a API do Instagram funcione, o app precisa ser aprovado ou estar em modo de desenvolvimento com os testadores certos.

**Modo Desenvolvimento (imediato):**
- Vá em **Funções → Adicionar Testadores**
- Adicione seu usuário do Facebook como testador
- Aceite o convite pelo perfil do Facebook

**Modo Produção (para usar com qualquer usuário):**
- Solicite aprovação das permissões:
  - `instagram_basic`
  - `instagram_manage_insights`
  - `pages_show_list`
  - `pages_read_engagement`

### Estrutura do Projeto

```
instagram-planner/
├── server.js          # Backend Express + OAuth + Anthropic
├── package.json
├── render.yaml        # Config do Render
├── .env.example       # Exemplo de variáveis
├── .gitignore
└── public/
    ├── index.html     # Landing page (não logado)
    └── app.html       # Painel principal (logado)
```

### Funcionalidades

- ✅ Login OAuth com Meta/Facebook
- ✅ Seleção de conta Instagram Business vinculada
- ✅ Leitura de seguidores, posts e bio reais
- ✅ Geração de plano via Claude (streaming)
- ✅ Funil estratégico de 4 semanas
- ✅ Scripts de Reels linha a linha
- ✅ 8+ sequências de Stories com slides
- ✅ Hashtags segmentadas (nicho, local, amplo)
- ✅ Calendário visual do mês
- ✅ Dicas de ouro personalizadas
- ✅ Histórico salvo no localStorage
- ✅ Interface dark mode completa
