# Development image only. The desktop shell (Tauri) must run on the host
# because it needs a window server and the macOS audio devices.
# Override with --build-arg NODE_IMAGE=<mirror>/library/node:22-alpine when
# Docker Hub is unreachable. Do not hardcode a mirror in the repository.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app

# Workspace manifests first so the dependency layer is cached independently
# of source edits.
COPY package.json package-lock.json ./
COPY apps/admin-console/package.json apps/admin-console/
COPY apps/desktop-shell/package.json apps/desktop-shell/
COPY packages/agent/package.json packages/agent/
COPY packages/contracts/package.json packages/contracts/
COPY services/orchestrator/package.json services/orchestrator/

RUN npm ci

COPY . .

CMD ["npm", "run", "start", "-w", "@craftmate/orchestrator"]
