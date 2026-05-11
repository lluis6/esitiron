FROM node:20-bookworm-slim
ENV LANG=C.UTF-8
WORKDIR /app

# Dependencias nativas para sharp/libvips
RUN apt-get update && apt-get install -y \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

RUN chown -R node:node /app
USER node

COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node . .

CMD ["node", "server.js"]