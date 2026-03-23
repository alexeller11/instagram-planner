# Instagram Marketing Planner — Inteligência Digital com IA

Este projeto é um planejador de marketing para Instagram que utiliza a API da Meta para obter dados reais do perfil e a **OpenAI (GPT-4o)** para gerar estratégias personalizadas e humanizadas.

## 🚀 Como Fazer o Deploy

### 1. Preparar o Repositório
1. Faça um fork ou clone este repositório para o seu GitHub.
2. Certifique-se de que o arquivo `Dockerfile` está na raiz.

### 2. Configurar Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto (ou configure as variáveis diretamente na sua plataforma de deploy, como Railway, Vercel, etc.) com as seguintes variáveis:

| Variável | Descrição |
|----------|-----------|
| `PORT` | Porta em que o servidor irá rodar (ex: `3000`) |
| `SESSION_SECRET` | Uma string longa e aleatória para segurança da sessão (ex: `sua-chave-secreta-super-longa-e-aleatoria`) |
| `BASE_URL` | A URL pública do seu aplicativo (ex: `http://localhost:3000` ou `https://seu-app.up.railway.app`) |
| `NODE_ENV` | Ambiente de execução (ex: `development` ou `production`) |
| `OPENAI_API_KEY` | Sua chave da API da OpenAI. Obtenha em [platform.openai.com](https://platform.openai.com/) |
| `IG_TOKENS` | Tokens de acesso de longa duração do Instagram, separados por vírgula. Gerados via [Meta for Developers](https://developers.facebook.com/apps/). |

**Exemplo de `.env`:**
```
PORT=3000
SESSION_SECRET=minha-chave-secreta-muito-segura-12345
BASE_URL=http://localhost:3000
NODE_ENV=development
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxx
IG_TOKENS=EAA...,EAA...
```

### 3. Executar Localmente

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Inicie o servidor:
   ```bash
   npm start
   ```
3. Acesse `http://localhost:3000` no seu navegador.

## 🧠 Inteligência Digital Humanizada

O sistema oferece análises e planejamentos aprofundados:
- **Análise de Nicho:** Identificação automática baseada nos posts reais.
- **Tom de Voz:** Detecção do estilo de escrita para manter a consistência.
- **Sugestões de Bio:** 3 variações (Autoridade, Conexão, Conversão) com emojis estratégicos.
- **Plano de Conteúdo:** 4 semanas de funil estratégico (Atenção, Autoridade, Conexão, Conversão).
- **Scripts de Reels:** Roteiros feitos para serem falados, com ganchos e CTAs fortes.

## 🛠️ Tecnologias Utilizadas
- **Backend:** Node.js + Express
- **IA:** OpenAI (GPT-4o)
- **API:** Instagram Graph API (v21.0)
- **Frontend:** HTML5 + JavaScript (Vanilla) + CSS Customizado

## 📄 Licença
Este projeto está sob a licença MIT.
