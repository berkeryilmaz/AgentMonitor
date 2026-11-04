FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY exporter.js ./
COPY sync_from_agy.py ./
COPY public ./public

RUN mkdir -p /app/data/mirror

EXPOSE 8090

ENV PORT=8090
ENV HOST=0.0.0.0

CMD ["node", "server.js"]
