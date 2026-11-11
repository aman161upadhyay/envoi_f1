FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node frontend/guard-demo/packages/core/crypto.mjs frontend/guard-demo/packages/core/webauthn.mjs ./frontend/guard-demo/packages/core/
COPY --chown=node:node frontend/guard-demo/adapters/near/read.mjs frontend/guard-demo/adapters/near/rpc.mjs ./frontend/guard-demo/adapters/near/
COPY --chown=node:node web ./web
COPY --chown=node:node db ./db
COPY --chown=node:node docs ./docs
# The reviewed agent-facing /connect skill content only (served by src/server.js).
COPY --chown=node:node integrations/onboarding/skill ./integrations/onboarding/skill
COPY --chown=node:node README.md ./README.md

ENV NODE_ENV=production
ENV ENVOI_AUTH_MODE=production
ENV ENVOI_HOST=0.0.0.0
ENV ENVOI_PORT=8787

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=7s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
