FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY main.mjs ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV WABOTIA_DATA=/app/data
CMD ["node", "main.mjs"]
