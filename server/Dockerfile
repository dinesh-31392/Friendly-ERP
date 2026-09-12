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

# Where uploaded documents live — agreements, KYC, demand-letter PDFs.
#
# TWO BUGS IN ONE LINE, both of which shipped:
#
#   1. storage.ts defaults FILE_STORAGE_DIR to `cwd()/var/uploads`, i.e.
#      /app/var/uploads. Everything under /app was COPYed as root, and the
#      process drops to `node` below — so the very first upload failed with
#      EACCES trying to mkdir /app/var. Document upload did not work at all in
#      production, and the failure surfaced as a 500 rather than as anything
#      naming a directory.
#   2. Even had it been writable, /app is inside the image. A rebuild replaces
#      the layer and every stored document with it.
#
# Creating the directory here, owned by `node`, fixes the permission; the
# compose file mounts a named volume over it, which fixes persistence. Docker
# seeds a fresh named volume from the image path INCLUDING its ownership, so
# the volume comes up node-owned rather than root-owned — which is why this
# mkdir has to exist even though a volume will cover it.
RUN mkdir -p /data/uploads && chown -R node:node /data
ENV FILE_STORAGE_DIR=/data/uploads

EXPOSE 4000
# Drop root: nothing here needs it, and a container escape shouldn't start as uid 0.
USER node
CMD ["node", "dist/src/index.js"]
