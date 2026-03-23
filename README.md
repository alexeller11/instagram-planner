# Instagram Marketing Planner — Deploy no Railway

Este projeto é um planejador de marketing para Instagram que utiliza a API da Meta para obter dados reais do perfil e a IA do Groq (Llama 3.3 70B) para gerar estratégias personalizadas e humanizadas.

## 🚀 Como fazer o Deploy no Railway

O Railway é a plataforma recomendada para este projeto devido à sua facilidade de uso e suporte nativo a Docker.

### 1. Preparar o Repositório
1. Faça um fork ou clone este repositório para o seu GitHub.
2. Certifique-se de que os arquivos `Dockerfile` e `railway.json` estão na raiz.

### 2. Configurar no Meta for Developers
1. Acesse [Meta for Developers](https://developers.facebook.com/apps/).
2. Selecione seu App (ou crie um novo do tipo "Consumidor" ou "Business").
3. Vá em **Configurações → Básico**.
4. Em **Domínios do App**, adicione o domínio que o Railway vai gerar (ex: `seu-app.up.railway.app`).
5. Vá em **Facebook Login → Configurações**.
6. Em **URIs de redirecionamento OAuth válidos**, adicione:
   ```
   https://seu-app.up.railway.app/auth/callback
   ```

### 3. Deploy no Railway
1. Acesse [Railway.app](https://railway.app/) e conecte sua conta do GitHub.
2. Clique em **New Project** → **Deploy from GitHub repo**.
3. Selecione este repositório.
4. O Railway detectará o `Dockerfile` automaticamente.

### 4. Variáveis de Ambiente (Environment Variables)
No painel do seu projeto no Railway, vá em **Variables** e adicione:

| Variável | Descrição |
|----------|-----------|
| `PORT` | `3000` |
| `SESSION_SECRET` | Uma string aleatória para segurança da sessão |
| `GROQ_API_KEY` | Sua chave da [Groq Cloud](https://console.groq.com/) |
| `IG_TOKENS` | Tokens de acesso do Instagram (separados por vírgula) |
| `BASE_URL` | A URL pública gerada pelo Railway (ex: `https://seu-app.up.railway.app`) |
| `NODE_ENV` | `production` |

---

## 🧠 Inteligência Digital Humanizada

O sistema foi atualizado para fornecer análises muito mais profundas:
- **Análise de Nicho:** Identificação automática baseada nos posts reais.
- **Tom de Voz:** Detecção do estilo de escrita para manter a consistência.
- **Sugestões de Bio:** 3 variações (Autoridade, Conexão, Conversão) com emojis estratégicos.
- **Plano de Conteúdo:** 4 semanas de funil estratégico (Atenção, Autoridade, Conexão, Conversão).
- **Scripts de Reels:** Roteiros feitos para serem falados, com ganchos e CTAs fortes.

## 🛠️ Tecnologias Utilizadas
- **Backend:** Node.js + Express
- **IA:** Groq SDK (Llama 3.3 70B Versatile)
- **API:** Instagram Graph API (v21.0)
- **Frontend:** HTML5 + TailwindCSS + JavaScript (Vanilla)

## 📄 Licença
Este projeto está sob a licença MIT.
