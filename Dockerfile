FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

# Instalar dependências básicas
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Garantir que as pastas de dados existam
RUN mkdir -p data/clients/metrics

EXPOSE 10000

CMD ["node", "server.js"]
