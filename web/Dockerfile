FROM node:26-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM scratch AS compile
COPY --from=builder /app/dist /