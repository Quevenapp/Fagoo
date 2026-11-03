# Build from the repository root. Freeze the resolved image digest before deployment.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* && openssl version | grep '^OpenSSL 3\.'
WORKDIR /app
COPY packages/fiscal-schema/requirements.txt ./packages/fiscal-schema/
RUN python3 -m venv /opt/fiscal-validator \
    && /opt/fiscal-validator/bin/pip install --no-cache-dir --only-binary=:all: -r packages/fiscal-schema/requirements.txt
COPY packages/fiscal-xml/package.json packages/fiscal-xml/package-lock.json ./packages/fiscal-xml/
RUN npm ci --omit=dev --ignore-scripts --prefix packages/fiscal-xml
COPY packages/fiscal-danfe/package.json packages/fiscal-danfe/package-lock.json ./packages/fiscal-danfe/
RUN npm ci --omit=dev --ignore-scripts --prefix packages/fiscal-danfe
COPY packages/fiscal-core/src/identity.mjs ./packages/fiscal-core/src/identity.mjs
COPY packages/fiscal-core/src/nfce-qr-profile.mjs ./packages/fiscal-core/src/nfce-qr-profile.mjs
COPY packages/fiscal-core/src/item-preparation.mjs packages/fiscal-core/src/review.mjs ./packages/fiscal-core/src/
COPY packages/erp-domain/src ./packages/erp-domain/src
COPY packages/fiscal-xml/src ./packages/fiscal-xml/src
COPY packages/fiscal-vault/src ./packages/fiscal-vault/src
COPY packages/fiscal-vault/trust ./packages/fiscal-vault/trust
COPY packages/backend-config/src ./packages/backend-config/src
COPY packages/fiscal-runtime/src ./packages/fiscal-runtime/src
COPY packages/fiscal-signed-rpc/src ./packages/fiscal-signed-rpc/src
COPY packages/fiscal-signed-orchestrator/src ./packages/fiscal-signed-orchestrator/src
COPY packages/fiscal-signed-custody/src ./packages/fiscal-signed-custody/src
COPY packages/fiscal-signed-runtime/src ./packages/fiscal-signed-runtime/src
COPY packages/fiscal-sefaz-wsdl/src ./packages/fiscal-sefaz-wsdl/src
COPY packages/fiscal-wsdl-runtime/src ./packages/fiscal-wsdl-runtime/src
COPY packages/fiscal-reconciliation/src ./packages/fiscal-reconciliation/src
COPY packages/fiscal-reconciliation-runtime/src ./packages/fiscal-reconciliation-runtime/src
COPY packages/fiscal-authorization/src ./packages/fiscal-authorization/src
COPY packages/fiscal-authorization/validator.py packages/fiscal-authorization/receipt-validator.py ./packages/fiscal-authorization/
COPY packages/fiscal-authorization/receipt-schema ./packages/fiscal-authorization/receipt-schema
COPY packages/fiscal-authorization/schema ./packages/fiscal-authorization/schema
COPY packages/fiscal-authorization-http/src ./packages/fiscal-authorization-http/src
COPY packages/fiscal-authorization-runtime/src ./packages/fiscal-authorization-runtime/src
COPY packages/fiscal-danfe/src ./packages/fiscal-danfe/src
COPY packages/fiscal-danfe-runtime/src ./packages/fiscal-danfe-runtime/src
COPY packages/fiscal-artifact-storage/src ./packages/fiscal-artifact-storage/src
COPY packages/fiscal-schema-runner/src ./packages/fiscal-schema-runner/src
COPY packages/fiscal-schema/validator.py packages/fiscal-schema/protocol_validator.py ./packages/fiscal-schema/
COPY packages/fiscal-schema/schemas ./packages/fiscal-schema/schemas
ENV NODE_ENV=production A1_OPENSSL_PATH=/usr/bin/openssl PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER node
# Check the production module graph before test-only COPY can mask a missing dependency.
RUN node --input-type=module -e "await import('./packages/fiscal-runtime/src/server.mjs')"

RUN /opt/fiscal-validator/bin/python3 -c "import importlib.util; s=importlib.util.spec_from_file_location('receipt_validator','packages/fiscal-authorization/receipt-validator.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.Validator()"

FROM base AS test
COPY workers/fiscal-executor/src/bridge.mjs ./workers/fiscal-executor/src/bridge.mjs
COPY packages/fiscal-core/src ./packages/fiscal-core/src
COPY packages/erp-domain/src ./packages/erp-domain/src
COPY packages/fiscal-vault/test ./packages/fiscal-vault/test
COPY packages/fiscal-xml/test/fixtures.mjs ./packages/fiscal-xml/test/fixtures.mjs
COPY packages/fiscal-xml/test/xml-declaration.test.mjs ./packages/fiscal-xml/test/xml-declaration.test.mjs
COPY packages/fiscal-signed-custody/test ./packages/fiscal-signed-custody/test
COPY packages/fiscal-schema-runner/test ./packages/fiscal-schema-runner/test
COPY packages/fiscal-schema/test/fixture.mjs ./packages/fiscal-schema/test/fixture.mjs
COPY packages/fiscal-core/test/fixtures.mjs ./packages/fiscal-core/test/fixtures.mjs
COPY packages/fiscal-core/test/business-fixtures.mjs ./packages/fiscal-core/test/business-fixtures.mjs
COPY packages/fiscal-signed-rpc/test/fixtures.mjs ./packages/fiscal-signed-rpc/test/fixtures.mjs
COPY packages/fiscal-runtime/test/server-composition.test.mjs ./packages/fiscal-runtime/test/server-composition.test.mjs
COPY packages/fiscal-runtime/test/wsdl-custody.test.mjs packages/fiscal-runtime/test/wsdl-server-trust.test.mjs ./packages/fiscal-runtime/test/
COPY packages/fiscal-runtime/test/protocol-custody.test.mjs ./packages/fiscal-runtime/test/
COPY packages/fiscal-sefaz-wsdl/test ./packages/fiscal-sefaz-wsdl/test
COPY packages/fiscal-wsdl-runtime/test ./packages/fiscal-wsdl-runtime/test
COPY packages/fiscal-danfe/test/fixtures.mjs ./packages/fiscal-danfe/test/fixtures.mjs
COPY packages/fiscal-danfe-runtime/test/fixtures.mjs packages/fiscal-danfe-runtime/test/handler.test.mjs packages/fiscal-danfe-runtime/test/protocol-dto.test.mjs ./packages/fiscal-danfe-runtime/test/
COPY packages/fiscal-danfe-runtime/test/processed-fixtures.mjs packages/fiscal-danfe-runtime/test/processed-source.test.mjs packages/fiscal-danfe-runtime/test/processed-handler.test.mjs ./packages/fiscal-danfe-runtime/test/
COPY packages/fiscal-danfe/test/processed-print.test.mjs ./packages/fiscal-danfe/test/
COPY packages/fiscal-authorization-http/test/fixtures.mjs ./packages/fiscal-authorization-http/test/fixtures.mjs
COPY packages/fiscal-authorization-runtime/test/closure-lookup.test.mjs packages/fiscal-authorization-runtime/test/closure-fixtures.mjs packages/fiscal-authorization-runtime/test/closure.test.mjs ./packages/fiscal-authorization-runtime/test/
COPY packages/fiscal-authorization-runtime/test/dispatch-fixtures.mjs packages/fiscal-authorization-runtime/test/dispatch.test.mjs packages/fiscal-authorization-runtime/test/dispatch-access.test.mjs ./packages/fiscal-authorization-runtime/test/
COPY packages/fiscal-authorization-runtime/test/fixtures.mjs packages/fiscal-authorization-runtime/test/handler.test.mjs packages/fiscal-authorization-runtime/test/review-fixtures.mjs packages/fiscal-authorization-runtime/test/review.test.mjs ./packages/fiscal-authorization-runtime/test/
COPY packages/fiscal-authorization-runtime/test/revalidation.test.mjs packages/fiscal-authorization-runtime/test/revalidation-fixtures.mjs ./packages/fiscal-authorization-runtime/test/
COPY packages/fiscal-authorization/test/receipt-query-public-fixture.mjs ./packages/fiscal-authorization/test/receipt-query-public-fixture.mjs
COPY packages/fiscal-authorization/test/gtin-rule-v2.test.mjs ./packages/fiscal-authorization/test/gtin-rule-v2.test.mjs
COPY packages/fiscal-authorization/test/emission-window.test.mjs packages/fiscal-authorization/test/emission-transport.test.mjs ./packages/fiscal-authorization/test/
COPY packages/fiscal-reconciliation/test/protocol-wire.mjs ./packages/fiscal-reconciliation/test/protocol-wire.mjs
COPY packages/fiscal-authorization/test/authorization-soap-binding.test.mjs packages/fiscal-authorization/test/service-fixtures.mjs packages/fiscal-authorization/test/receipt-fixtures.mjs packages/fiscal-authorization/test/stored-response-reader.test.mjs ./packages/fiscal-authorization/test/
ENV BRUFAP_TEST_OPENSSL_PATH=/usr/bin/openssl
ENV BRUFAP_TEST_PYTHON=/opt/fiscal-validator/bin/python3
RUN node --test packages/fiscal-authorization/test/gtin-rule-v2.test.mjs
RUN node --test packages/fiscal-authorization/test/emission-window.test.mjs packages/fiscal-authorization/test/emission-transport.test.mjs
RUN node --test packages/fiscal-xml/test/xml-declaration.test.mjs packages/fiscal-authorization/test/authorization-soap-binding.test.mjs packages/fiscal-authorization/test/stored-response-reader.test.mjs
RUN node --test packages/fiscal-vault/test/*.test.mjs
RUN BRUFAP_SCHEMA_PROCESS_TEST=1 node --test packages/fiscal-signed-custody/test/*.test.mjs packages/fiscal-schema-runner/test/*.test.mjs
RUN node --test packages/fiscal-runtime/test/server-composition.test.mjs packages/fiscal-runtime/test/wsdl-custody.test.mjs packages/fiscal-runtime/test/wsdl-server-trust.test.mjs packages/fiscal-runtime/test/protocol-custody.test.mjs
RUN node --test packages/fiscal-sefaz-wsdl/test/preparation-diagnostic.test.mjs
RUN node --test packages/fiscal-authorization-runtime/test/revalidation.test.mjs packages/fiscal-authorization-runtime/test/closure-lookup.test.mjs packages/fiscal-authorization-runtime/test/closure.test.mjs packages/fiscal-authorization-runtime/test/handler.test.mjs packages/fiscal-authorization-runtime/test/review.test.mjs packages/fiscal-authorization-runtime/test/dispatch.test.mjs packages/fiscal-authorization-runtime/test/dispatch-access.test.mjs
RUN node --test packages/fiscal-danfe-runtime/test/handler.test.mjs packages/fiscal-danfe-runtime/test/protocol-dto.test.mjs
RUN node --test packages/fiscal-danfe-runtime/test/processed-source.test.mjs packages/fiscal-danfe-runtime/test/processed-handler.test.mjs packages/fiscal-danfe/test/processed-print.test.mjs

FROM base AS production
EXPOSE 8080
CMD ["node", "--disable-proto=throw", "packages/fiscal-runtime/src/server.mjs"]
