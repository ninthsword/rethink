# Build stage
FROM alpine:3.20 AS build
WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev
RUN chmod -R a+rX dist node_modules

# Production stage
FROM alpine:3.20 AS runtime
WORKDIR /app

RUN apk add --no-cache nodejs openssl \
	&& addgroup -S app \
	&& adduser -S -G app app

COPY --from=build --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=0444 config.jsonc /app/config.json

RUN mkdir -p /app/data \
	&& chown app:app /app/data

USER app

RUN bad_dirs="$(find /app/dist /app/node_modules -type d ! -perm -o+x -print -quit)" \
    && test -z "$bad_dirs" \
    && bad_files="$(find /app/dist /app/node_modules -type f ! -perm -o+r -print -quit)" \
    && test -z "$bad_files" \
    && node -e 'if (require("/app/package.json").type !== "module") process.exit(1)'

EXPOSE 443 8883 1884 46030 47878 44401
CMD ["sh", "-c", "[ -f /app/data/config.json ] || cp /app/config.json /app/data/config.json; exec node dist/rethink-cloud.js /app/data/config.json"]
