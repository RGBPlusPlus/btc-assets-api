FROM node:22-slim

WORKDIR /app

COPY . .

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm so the dependency build policy does not drift with Corepack defaults.
RUN corepack enable pnpm && corepack install --global pnpm@11.25.0

RUN --mount=type=cache,id=pnpm,target=/pnpm/store SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile
RUN pnpm run build

EXPOSE 3000

ENV NODE_ENV=production
ENV ADDRESS=0.0.0.0 PORT=3000

CMD ["pnpm", "start"]
