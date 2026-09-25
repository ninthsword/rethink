FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3
WORKDIR /app
COPY --chmod=0444 package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chmod=0444 service.mjs session-store.mjs login.html login.js login.css ui.js ui.css ./
USER node
ENTRYPOINT ["node"]
CMD ["service.mjs"]
