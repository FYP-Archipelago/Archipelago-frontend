# Archipelago web, in one container.
#
# The built app is served by `vite preview`, which carries the same run-library
# routes as the dev server (see vite.config.ts), so nothing else is needed: no
# nginx, no separate data service. Mount a run library at /app/data.
#
#   docker compose up --build        (from the repo root)
#   open http://localhost:5173

FROM node:22-alpine AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/web
ENV NODE_ENV=production \
    ARCHIPELAGO_DATA=/app/data
COPY --from=build /app/web /app/web
RUN mkdir -p /app/data
EXPOSE 5173
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
