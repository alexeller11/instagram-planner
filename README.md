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
| `IG_TOKENS` | Tokens de acesso do Instagram (opcional, separados por vírgula) |
| `BASE_URL` | A URL pública gerada pelo Railway (ex: `https://seu-app.up.railway.app`) |
| `NODE_ENV` | `production` |

### 5. Considerações para o Plano Free do Railway

O Railway oferece um plano gratuito com **$5 em créditos por mês**, que expiram após 30 dias se não forem utilizados [1]. Este plano é ideal para protótipos e projetos pequenos, mas possui algumas limitações importantes a serem consideradas para evitar custos inesperados ou interrupções no serviço [2]:

| Recurso | Limite do Plano Free [1] |
|---|---|
| **vCPU** | Até 1 vCPU por serviço |
| **RAM** | 0.5 GB por serviço |
| **Armazenamento** | 0.5 GB de volume |
| **Créditos** | $5 por mês (expiram em 30 dias) |
| **Suporte** | Comunidade |

**Dicas para Otimizar o Uso no Plano Free:**

*   **Monitore o Uso:** Acompanhe o consumo de recursos no painel do Railway para garantir que você permaneja dentro dos limites do plano gratuito. O uso excessivo pode gerar cobranças [3].
*   **Otimize o Código:** Certifique-se de que o seu aplicativo Node.js seja o mais eficiente possível em termos de uso de CPU e memória. Evite operações que consumam muitos recursos desnecessariamente.
*   **Gerenciamento de Dependências:** Utilize `npm ci` em vez de `npm install` no `Dockerfile` para garantir instalações consistentes e potencialmente mais rápidas, embora para este projeto `npm install` já seja suficiente.
*   **Desligamento Automático:** O Railway pode suspender serviços inativos para economizar recursos. Esteja ciente de que pode haver um pequeno atraso na inicialização após um período de inatividade.
*   **Uso da IA (Groq):** A API do Groq é rápida e eficiente, mas o uso intensivo pode consumir os créditos rapidamente. Utilize-a de forma consciente.

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

## Referências
[1] [Pricing - Railway](https://railway.com/pricing)
[2] [Railway Pricing 2026: Plans, Costs & Free Options | AISO Tools](https://aisotools.com/pricing/railway)
[3] [Understanding Your Bill | Railway Docs](https://docs.railway.com/pricing/understanding-your-bill)
