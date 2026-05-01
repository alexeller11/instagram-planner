# 🚀 Guia de Configuração — Instagram Planner

## 1. Configuração dos Tokens do Instagram Graph API

O **Instagram Planner** carrega automaticamente seus clientes a partir dos tokens configurados no ambiente. Siga este guia para gerar e configurar os tokens.

### Passo 1: Acessar Meta for Developers

1. Acesse [https://developers.facebook.com/](https://developers.facebook.com/)
2. Faça login com sua conta Meta/Facebook
3. Clique em **"Meus Apps"** (canto superior direito)

### Passo 2: Criar ou Selecionar um App

- Se já tem um app: clique nele
- Se não tem: clique em **"Criar App"** → **"Negócios"** → Preencha os dados

### Passo 3: Configurar Permissões do App

1. No painel do app, vá para **"Configurações"** → **"Básico"**
2. Copie e guarde o **ID do App** e **Chave Secreta do App**
3. Vá para **"Produtos"** e procure por **"Instagram Graph API"**
4. Se não estiver lá, clique em **"Adicionar Produto"** e procure por **"Instagram"**

### Passo 4: Gerar User Access Token

1. Vá para **"Ferramentas"** → **"Graph API Explorer"**
2. No dropdown do app (lado esquerdo), selecione seu app
3. No dropdown do token, selecione **"Gerar Token de Acesso"**
4. Autorize as seguintes permissões:
   - `instagram_business_content_publish`
   - `instagram_basic`
   - `pages_read_engagement`
   - `pages_read_user_content`

5. Copie o token gerado (começa com `IGQA...` ou similar)

### Passo 5: Converter para Long-Lived Token (Recomendado)

Os tokens padrão expiram em **1 hora**. Converta para Long-Lived Token (válido por **60 dias**):

```bash
curl -i -X GET "https://graph.instagram.com/access_token?grant_type=ig_refresh_token&access_token=SEU_TOKEN_AQUI"
```

Copie o novo token retornado.

### Passo 6: Configurar no Render (Produção)

1. Acesse seu dashboard do [Render](https://dashboard.render.com/)
2. Clique no seu serviço **"instagram-planner-agency"**
3. Vá para **"Environment"**
4. Procure por **"IG_TOKENS"** e clique em **"Edit"**
5. Cole o token (ou múltiplos tokens separados por vírgula, ponto e vírgula ou quebra de linha)
6. Clique em **"Save"**
7. O app será redeploy automaticamente

### Passo 7: Configurar Localmente (Desenvolvimento)

1. Crie um arquivo `.env` na raiz do projeto
2. Adicione a linha:
   ```
   IG_TOKENS=seu_token_aqui
   ```
3. Se tiver múltiplos clientes:
   ```
   IG_TOKENS=token_cliente_1,token_cliente_2,token_cliente_3
   # Ou use quebra de linha para organizar melhor:
   IG_TOKENS="
   token_1,
   token_2,
   token_3
   "
   ```

## 2. Verificar se os Clientes Foram Carregados

Após configurar os tokens:

1. **Localmente**: Execute `npm start` e acesse `http://localhost:3000`
2. **No Render**: Acesse sua URL do app
3. Verifique se os clientes aparecem no dropdown superior

Se não aparecerem, verifique:
- Os tokens estão corretos?
- Os tokens têm as permissões corretas?
- Os tokens ainda não expiraram?
- Há logs de erro no console?

## 3. Autorizar Clientes no Meta Developer

Para cada cliente que você quer adicionar:

1. Peça ao cliente para autorizar seu app em [https://www.instagram.com/accounts/login/](https://www.instagram.com/accounts/login/)
2. Gere um token de acesso para aquele cliente
3. Adicione o token à variável `IG_TOKENS`

## 4. Dados Que Serão Carregados

Quando um token é validado, o app carrega automaticamente:

- **ID da Conta**: ID único do Instagram Business
- **Username**: @username do cliente
- **Nome da Marca**: Nome da conta
- **Biografia**: Bio atual do perfil
- **Foto de Perfil**: URL da imagem
- **Seguidores**: Contagem de seguidores

Esses dados são mesclados com informações adicionais (nicho, público-alvo, etc.) que você pode editar depois.

## 5. Troubleshooting

### "Nenhum cliente aparece"
- Verifique se `IG_TOKENS` está configurado
- Confirme que os tokens têm as permissões corretas
- Verifique os logs do servidor

### "Erro 400: Invalid Request"
- O token pode estar expirado
- Gere um novo Long-Lived Token

### "Erro 401: Unauthorized"
- O token não tem as permissões corretas
- Regenere o token com as permissões listadas acima

### "Erro 403: Forbidden"
- Seu app não foi aprovado para usar Instagram Graph API
- Submeta para revisão no Meta for Developers

## 6. Próximos Passos

Após configurar os tokens:

1. Acesse o dashboard do app
2. Selecione um cliente no dropdown
3. Explore as funcionalidades:
   - **Performance**: Métricas e análises
   - **Estratégia**: Auditoria de posicionamento
   - **Planejador**: Geração de conteúdo
   - **Mercado**: Análise de concorrência

---

**Dúvidas?** Consulte a [documentação oficial do Instagram Graph API](https://developers.facebook.com/docs/instagram-api)
