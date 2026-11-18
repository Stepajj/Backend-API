FROM node:24-alpine AS build
WORKDIR /app
ENV DATABASE_URL=postgresql://regear:regear@localhost:5432/regear?schema=public
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npm ci
RUN npx prisma generate
COPY src ./src
RUN npm run build

FROM node:24-alpine AS migrate
WORKDIR /app
ENV DATABASE_URL=postgresql://regear:regear@localhost:5432/regear?schema=public
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL=postgresql://regear:regear@localhost:5432/regear?schema=public npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
RUN mkdir -p uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
