# Build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_MODE=http
ENV VITE_API_MODE=$VITE_API_MODE
RUN npm run build

# Runtime : Nginx non-root (PRD §10), port 8080 attendu par Cloud Run
FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV API_UPSTREAM=http://api:8080 API_HOST=api
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
