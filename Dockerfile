FROM node:22.15.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
# The public GitHub install uses `prepare` to build the untracked dist tree.
# Container builds copy source in the following step and run the build
# explicitly, so dependency installation must not invoke prepare early.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.15.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/cloud/runtime/main.js"]
