# --- Build stage ---------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Install deps first for layer caching. `npm ci` runs the postinstall hook that
# downloads the scrcpy server binary (so the build needs network access).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage -------------------------------------------------------
# Static files served by nginx. WebUSB needs HTTPS (or http://localhost), so put
# this behind a TLS-terminating reverse proxy in production; the network and
# ADB-server transports also need an HTTPS page to use wss://.
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
