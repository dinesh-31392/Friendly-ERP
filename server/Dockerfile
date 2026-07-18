# Friendly CRM API — production image
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# tsx is needed for the migrate/seed scripts on first boot.
# `npm i -D` is a NO-OP here: ENV NODE_ENV=production above makes npm default to
# omit=dev, so this silently installed NOTHING (it only added a devDependencies
# entry) and `npx tsx scripts/migrate.ts` from DEPLOY.md then had no local tsx —
# reaching out to the registry mid-deploy, or just failing. --include=dev
# overrides the omit; --no-save keeps package.json untouched.
RUN npm i --no-save --include=dev tsx typescript @types/node @types/pg @types/jsonwebtoken
COPY scripts ./scripts
COPY src ./src
EXPOSE 4000
# Drop root: nothing here needs it, and a container escape shouldn't start as uid 0.
USER node
CMD ["node", "dist/src/index.js"]
