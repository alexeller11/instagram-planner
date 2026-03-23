# Instagram Marketing Planner — Deploy no Railway

Este projeto é um planejador de marketing para Instagram que utiliza a API da Meta para obter dados reais do perfil e o **Google Gemini Pro (v1.0)** para gerar estratégias personalizadas e humanizadas, com controle de orçamento de tokens integrado.

## 🚀 Como fazer o Deploy no Railway

O Railway é a plataforma recomendada para este projeto devido à sua facilidade de uso e suporte nativo a Docker.

### 1. Preparar o Repositório
1. Faça um fork ou clone este repositório para o seu GitHub.
2. Certifique-se de que o arquivo `Dockerfile` está na raiz. O Railway detectará as configurações automaticamente.
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
| `GEMINI_API_KEY` | Sua chave do [Google AI Studio](https://aistudio.google.com/) |
| `MAX_GEMINI_COST` | Orçamento máximo mensal em dólares (padrão: `5`) |
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
*   **Uso da IA (Gemini):** A API do Gemini Pro (v1.0) é rápida e eficiente. O sistema possui controle automático de orçamento via `MAX_GEMINI_COST`. Consulte `/api/token-status` para monitorar o consumo em tempo real.

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
- **IA:** Google Gemini Pro (v1.0) (via @google/generative-ai)
- **API:** Instagram Graph API (v21.0)
- **Frontend:** HTML5 + TailwindCSS + JavaScript (Vanilla)

## 📄 Licença
Este projeto está sob a licença MIT.

## Referências
[1] [Pricing - Railway](https://railway.com/pricing)
[2] [Railway Pricing 2026: Plans, Costs & Free Options | AISO Tools](https://aisotools.com/pricing/railway)
[3] [Understanding Your Bill | Railway Docs](https://docs.railway.com/pricing/understanding-your-bill)


## ⚙️ Configuração Essencial para o Funcionamento do App

Para que o seu Instagram Planner funcione corretamente, especialmente o login com o Instagram (via Meta API), é crucial configurar duas coisas:

1.  **Variável `SESSION_SECRET` no Railway:** Essencial para a segurança das sessões de utilizador.
2.  **App da Meta (Facebook for Developers):** Para permitir o login OAuth e o acesso aos dados do Instagram.

---

### Passo a Passo: Configurar `SESSION_SECRET` no Railway

A variável `SESSION_SECRET` é usada pelo Express para assinar os cookies de sessão, garantindo que as sessões dos utilizadores sejam seguras e não possam ser adulteradas. É fundamental que seja uma string longa, aleatória e secreta.

1.  **Gerar um `SESSION_SECRET` Seguro:**
    *   Podes gerar uma string aleatória online (ex: [gerador de senhas aleatórias](https://www.random.org/strings/?num=1&len=32&digits=on&upperalpha=on&loweralpha=on&unique=on&format=plain&rnd=new)).
    *   **Exemplo:** `sua-string-secreta-super-longa-e-aleatoria-aqui-1234567890`

2.  **Adicionar ao Railway:**
    *   Acede ao painel do teu projeto no [Railway](https://railway.app/).
    *   Vai à secção **Variables**.
    *   Clica em **New Variable** (ou **Editor Bruto** para adicionar em massa).
    *   Cria uma nova variável com o nome `SESSION_SECRET` e cola a string gerada no campo **Value**.
    *   Certifica-te de que a variável está guardada.

---

### Passo a Passo: Configurar o App da Meta (Facebook for Developers)

Esta configuração permite que o teu aplicativo se comunique com a API do Instagram e do Facebook para autenticar utilizadores e aceder aos seus dados (com permissão).

1.  **Aceder ao Painel de Desenvolvedor:**
    *   Vai a [Meta for Developers](https://developers.facebook.com/apps/) e faz login.
    *   Seleciona o teu aplicativo (ou cria um novo se ainda não o fizeste, escolhendo o tipo "Consumidor" ou "Business").

2.  **Configurações Básicas do App:**
    *   No menu lateral, vai a **Configurações** > **Básico**.
    *   **Domínios do App:** Adiciona o domínio público do teu aplicativo no Railway. Será algo como `seu-app.up.railway.app`.
    *   **URL da Política de Privacidade:** É recomendado ter uma (podes usar a `privacy.html` do projeto, hospedada em `seu-app.up.railway.app/privacy.html`).
    *   **URL dos Termos de Serviço:** Opcional, mas recomendado.
    *   **URL de Exclusão de Dados do Utilizador:** Opcional, mas recomendado.
    *   **Categoria:** Escolhe uma categoria relevante para o teu app.
    *   **Guarda as Alterações.**

3.  **Configurações de Login com Facebook (OAuth):**
    *   No menu lateral, vai a **Login com Facebook** > **Configurações**.
    *   **URIs de redirecionamento OAuth válidos:** Este é o passo mais crítico para o login funcionar.
        *   Adiciona a URL completa de callback do teu aplicativo no Railway, que é `https://seu-app.up.railway.app/auth/callback`.
        *   **Importante:** Substitui `seu-app.up.railway.app` pelo domínio real do teu aplicativo no Railway.
    *   **Guarda as Alterações.**

4.  **Adicionar Produtos (se ainda não tiveres):**
    *   No menu lateral, clica em **Adicionar Produto**.
    *   Adiciona **Login com Facebook** e **Exibição Básica do Instagram** (Instagram Basic Display).

5.  **Configurar Exibição Básica do Instagram:**
    *   No menu lateral, vai a **Exibição Básica do Instagram** > **Criação de Aplicativo**.
    *   Cria um novo aplicativo de exibição básica.
    *   **URIs de redirecionamento OAuth válidos:** Adiciona `https://seu-app.up.railway.app/auth/callback`.
    *   **URIs de cancelamento de autorização:** Adiciona `https://seu-app.up.railway.app/`.
    *   **URL da Política de Privacidade:** Adiciona `https://seu-app.up.railway.app/privacy.html`.
    *   **Guarda as Alterações.**

6.  **Adicionar Testadores (Modo de Desenvolvimento):**
    *   Se o teu aplicativo ainda estiver em **Modo de Desenvolvimento** (não publicado), precisas de adicionar contas de teste para poder fazer login.
    *   No menu lateral, vai a **Funções** > **Funções**.
    *   Na secção **Testadores**, clica em **Adicionar Testadores**.
    *   Adiciona o teu utilizador do Facebook (e de outros que queiras testar) e pede para aceitarem o convite através das notificações do Facebook.

Após seguir estes passos e o Railway ter feito o redeploy, o teu Instagram Planner deverá estar a funcionar corretamente com o login do Instagram. Se tiveres alguma dúvida ou encontrares algum problema, avisa-me!
