# Usar uma imagem base do Node.js 18 mais leve (alpine) para economizar recursos
FROM node:18-alpine

# Definir o diretório de trabalho
WORKDIR /app

# Copiar apenas os arquivos de dependências primeiro para aproveitar o cache do Docker
COPY package*.json ./

# Instalar dependências (apenas produção para economizar espaço e RAM)
RUN npm install --production

# Copiar o restante dos arquivos do projeto
COPY . .

# Comando para iniciar o servidor
CMD ["npm", "start"]
