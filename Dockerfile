# ── MediCore AI (TypeScript) — Multi-stage container ─────────────────────────
#
# One image, any agent. AGENT_MODULE selects which server to start at runtime.
#
# Available modules:
#   orchestrator              → port 8003  (primary entry point)
#   intake_agent              → port 8002
#   diagnosis_agent           → port 8001
#   care_navigator_agent      → port 8004
#   treatment_planner_agent   → port 8005
#   insurance_billing_agent   → port 8006
#   followup_adherence_agent  → port 8007
#   health_memory_agent       → port 8008
#   social_barrier_agent      → port 8009
#
# Local build + run:
#   docker build -t medicore-ai .
#   docker run --rm -p 8003:8003 \
#     -e AGENT_MODULE=orchestrator \
#     -e OPENROUTER_API_KEY=sk-or-v1-... \
#     -e ORCHESTRATOR_URL=https://<ngrok>.ngrok-free.app \
#     medicore-ai
#
# Full stack (docker compose):
#   docker compose up --build

FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first — cached layer unless package.json changes
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Only copy production deps and compiled output
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Cloud Run sets PORT=8080; default to 8080 for local Docker testing.
ENV PORT=8080

# Which agent to serve. Default: orchestrator (main entry point).
ENV AGENT_MODULE=orchestrator

CMD ["sh", "-c", "node dist/${AGENT_MODULE}/server.js"]
