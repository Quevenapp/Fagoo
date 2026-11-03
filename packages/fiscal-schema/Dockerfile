# Isolated offline CLI, built from the repository root. No HTTP service or A1 custody.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS validator
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/fiscal-schema/requirements.txt ./packages/fiscal-schema/
RUN python3 -m venv /opt/fiscal-validator \
    && /opt/fiscal-validator/bin/pip install --no-cache-dir --only-binary=:all: -r packages/fiscal-schema/requirements.txt
COPY packages/fiscal-schema/validator.py packages/fiscal-schema/protocol_validator.py ./packages/fiscal-schema/
COPY packages/fiscal-schema/schemas ./packages/fiscal-schema/schemas
ENV PATH="/opt/fiscal-validator/bin:${PATH}" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER node

FROM validator AS test
USER root
COPY packages/fiscal-xml/package.json packages/fiscal-xml/package-lock.json ./packages/fiscal-xml/
RUN npm ci --omit=dev --ignore-scripts --prefix packages/fiscal-xml
COPY packages/fiscal-core/src/identity.mjs ./packages/fiscal-core/src/identity.mjs
COPY packages/fiscal-core/test/fixtures.mjs ./packages/fiscal-core/test/fixtures.mjs
COPY packages/fiscal-xml/src ./packages/fiscal-xml/src
COPY packages/fiscal-xml/test/fixtures.mjs ./packages/fiscal-xml/test/fixtures.mjs
COPY packages/fiscal-schema/test/fixture.mjs packages/fiscal-schema/test/protocol-fixture.mjs packages/fiscal-schema/test/protocol-soap-fixture.mjs ./packages/fiscal-schema/test/
COPY packages/fiscal-schema/test/test_validator.py packages/fiscal-schema/test/test_protocol_validator.py packages/fiscal-schema/test/test_protocol_soap.py packages/fiscal-schema/test/test_distribution_contract.py ./packages/fiscal-schema/test/
USER node
RUN python3 -m unittest discover -s packages/fiscal-schema/test -p 'test_*.py' -v

FROM validator AS production
ENTRYPOINT ["/opt/fiscal-validator/bin/python3", "packages/fiscal-schema/validator.py"]
