FROM node:20-alpine

ENV LANG=C.UTF-8

WORKDIR /app
RUN chown -R node:node /app
COPY package*.json ./
RUN npm install
RUN npm install prom-client
COPY . .
CMD ["node", "server.js"]
