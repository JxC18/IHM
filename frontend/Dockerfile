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
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
