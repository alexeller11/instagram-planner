# 🔐 Configuração do Facebook Login

Este guia explica como configurar o Facebook Login no Instagram Planner para carregar automaticamente os clientes do Instagram.

## Por que usar Facebook Login?

- ✅ **Tokens de longa duração** (60 dias) - sem expiração rápida
- ✅ **Renovação automática** - tokens são renovados automaticamente
- ✅ **Segurança** - não precisa armazenar tokens manualmente
- ✅ **Escalabilidade** - suporta múltiplos usuários/clientes
- ✅ **Experiência melhor** - login simples com um clique

## Passo 1: Preparar o App Meta

### 1.1 Acessar Meta for Developers

1. Vá para [https://developers.facebook.com/](https://developers.facebook.com/)
2. Faça login com sua conta Meta/Facebook
3. Clique em **"Meus Apps"** (canto superior direito)

### 1.2 Criar ou Selecionar um App

- Se já tem um app: clique nele
- Se não tem: clique em **"Criar App"** → **"Negócios"** → Preencha os dados

### 1.3 Copiar as Credenciais

1. No painel do app, vá para **"Configurações"** → **"Básico"**
2. Copie e guarde:
   - **ID do App** (FACEBOOK_APP_ID)
   - **Chave Secreta do App** (FACEBOOK_APP_SECRET)

## Passo 2: Configurar Permissões e Produtos

### 2.1 Adicionar Produto Instagram

1. No painel do app, vá para **"Produtos"**
2. Procure por **"Instagram Graph API"**
3. Se não estiver lá, clique em **"Adicionar Produto"** e procure por **"Instagram"**

### 2.2 Configurar Permissões

1. Vá para **"Configurações"** → **"Básico"**
2. Role até **"Permissões do App"** e adicione:
   - `instagram_business_content_publish`
   - `instagram_basic`
   - `pages_read_engagement`
   - `pages_read_user_content`
   - `pages_manage_metadata`

### 2.3 Configurar URLs de Redirecionamento

1. Vá para **"Configurações"** → **"Básico"**
2. Em **"URLs de Redirecionamento OAuth Válidas"**, adicione:
   - **Desenvolvimento**: `http://localhost:3000/auth/facebook/callback`
   - **Produção (Render)**: `https://seu-app.onrender.com/auth/facebook/callback`

## Passo 3: Configurar no Render (Produção)

### 3.1 Adicionar Variáveis de Ambiente

1. Acesse seu dashboard do [Render](https://dashboard.render.com/)
2. Clique no seu serviço **"instagram-planner-agency"**
3. Vá para **"Environment"**
4. Adicione as seguintes variáveis:

```
FACEBOOK_APP_ID=seu_app_id_aqui
FACEBOOK_APP_SECRET=sua_app_secret_aqui
FACEBOOK_REDIRECT_URI=https://seu-app.onrender.com/auth/facebook/callback
BASE_URL=https://seu-app.onrender.com
```

### 3.2 Atualizar o Servidor

1. Altere o arquivo `server.js` para usar `server-v2.js`:
   ```bash
   mv server.js server-old.js
   mv server-v2.js server.js
   ```

2. Faça commit e push:
   ```bash
   git add .
   git commit -m "Use Facebook Login as default"
   git push origin main
   ```

3. O Render fará deploy automaticamente

## Passo 4: Configurar Localmente (Desenvolvimento)

### 4.1 Criar Arquivo `.env`

Crie um arquivo `.env` na raiz do projeto:

```bash
# Copie do .env.example
cp .env.example .env
```

### 4.2 Adicionar Credenciais

Edite o arquivo `.env` e adicione:

```
FACEBOOK_APP_ID=seu_app_id_aqui
FACEBOOK_APP_SECRET=sua_app_secret_aqui
FACEBOOK_REDIRECT_URI=http://localhost:3000/auth/facebook/callback
BASE_URL=http://localhost:3000
```

### 4.3 Usar o Novo Server

```bash
# Alterar server.js para usar a versão com Facebook Login
mv server.js server-old.js
mv server-v2.js server.js

# Instalar dependências (se necessário)
npm install

# Iniciar o servidor
npm start
```

## Passo 5: Testar o Login

### 5.1 Localmente

1. Abra `http://localhost:3000`
2. Clique em **"Conectar com Meta"**
3. Faça login com sua conta Meta/Facebook
4. Autorize as permissões
5. Você será redirecionado para o dashboard com seus clientes carregados

### 5.2 No Render

1. Acesse sua URL do Render
2. Clique em **"Conectar com Meta"**
3. Siga o mesmo processo

## Troubleshooting

### "Erro: Credenciais inválidas"
- Verifique se `FACEBOOK_APP_ID` e `FACEBOOK_APP_SECRET` estão corretos
- Certifique-se de que estão no arquivo `.env` (desenvolvimento) ou Environment (Render)

### "Erro: URL de redirecionamento não autorizada"
- Verifique se a URL em `FACEBOOK_REDIRECT_URI` está configurada no Meta for Developers
- Certifique-se de que corresponde à URL do seu app

### "Nenhuma conta do Instagram encontrada"
- Verifique se você tem uma conta Instagram Business vinculada a uma página do Facebook
- Certifique-se de que autorizou as permissões corretas

### "Token expirado"
- Os tokens agora são renovados automaticamente a cada 24 horas
- Se ainda assim expirar, faça login novamente

## Próximos Passos

Após configurar o Facebook Login:

1. **Remova o arquivo `server-old.js`** (não é mais necessário)
2. **Teste em produção** no Render
3. **Compartilhe o link** com seus clientes
4. **Cada cliente** faz login com sua conta Meta e vê seus dados automaticamente

## Documentação Oficial

- [Facebook Login Documentation](https://developers.facebook.com/docs/facebook-login)
- [Instagram Graph API](https://developers.facebook.com/docs/instagram-api)
- [OAuth 2.0 Authorization](https://developers.facebook.com/docs/facebook-login/manually-build-a-login-flow)

---

**Dúvidas?** Consulte a [documentação oficial do Meta for Developers](https://developers.facebook.com/docs)
