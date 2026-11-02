FROM node:24-bookworm-slim AS deployment-tools
WORKDIR /opt/fagoo-deployer
COPY infra/runtime/package.json infra/runtime/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim
ARG SOURCE_COMMIT=source
LABEL org.opencontainers.image.source="https://github.com/Quevenapp/Fagoo" org.opencontainers.image.revision="${SOURCE_COMMIT}"
ENV NODE_ENV=production PORT=3000
ENV PATH="/opt/fiscal-validator/bin:${PATH}" PYTHONDONTWRITEBYTECODE=1
ENV FAGOO_FISCAL_PYTHON=/opt/fiscal-validator/bin/python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --workspaces=false && npm cache clean --force
COPY packages/fiscal-schema/requirements.txt /tmp/fiscal-requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv openssl \
    && python3 -m venv /opt/fiscal-validator \
    && /opt/fiscal-validator/bin/pip install --no-cache-dir -r /tmp/fiscal-requirements.txt \
    && rm -rf /var/lib/apt/lists/* /tmp/fiscal-requirements.txt
COPY --from=deployment-tools /opt/fagoo-deployer /opt/fagoo-deployer
COPY apps/api ./apps/api
COPY apps/web/dist ./apps/web/dist
COPY packages ./packages
COPY spec ./spec
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/server.mjs"]
