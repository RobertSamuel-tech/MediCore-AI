# MediCore AI — Multi-Agent Healthcare Platform (TypeScript)
### OpenRouter · A2A Protocol 0.3.0 · Medplum FHIR R4 · Node.js

A production-ready multi-agent healthcare coordination system that connects to **[Prompt Opinion](https://promptopinion.ai)** via the A2A protocol. One ngrok tunnel, two agents, full clinical intelligence.

---

## Contents

- [Architecture](#architecture)
- [Agents](#agents)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Running the server](#running-the-server)
- [Connecting to Prompt Opinion](#connecting-to-prompt-opinion)
- [Testing endpoints](#testing-endpoints)
- [Shared library](#shared-library)
- [Docker](#docker)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
Prompt Opinion
     │  POST /         → MediCore AI Orchestrator
     │  POST /memory   → Health Memory Agent
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  ngrok tunnel  (single tunnel, two agents)          │
│  https://<ngrok>.ngrok-free.dev  → localhost:8003   │
└────────────────────┬────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │  orchestrator/      │  POST /
          │  Express app        │  GET  /.well-known/agent-card.json
          │                     │
          │  app.use('/memory', healthMemoryApp)
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  health_memory_     │  POST /memory
          │  agent sub-app      │  GET  /memory/.well-known/agent-card.json
          └──────────┬──────────┘
                     │
     ┌───────────────┼───────────────────────┐
     ▼               ▼                       ▼
OpenRouter      Medplum FHIR R4         specialist agents
(LLM calls)   (longitudinal memory)  (called in-process)
```

**Key design decisions:**

- **One port, two agents** — the orchestrator and health memory agent share port 8003 via Express sub-app mounting, so one ngrok tunnel serves both.
- **OpenRouter for all LLM calls** — replaces Google Gemini/ADK runner. Any model on OpenRouter works (default: `deepseek/deepseek-chat`).
- **Medplum FHIR R4** — health memory agent reads longitudinal patient data (conditions, medications, allergies, vitals, labs, referrals) from Medplum with a 5-minute cache.
- **A2A 0.3.0 compliant** — agent cards include `supportedInterfaces`, `preferredTransport`, and `protocolVersion` exactly as Prompt Opinion expects.

---

## Agents

### MediCore AI Orchestrator

Enterprise clinical decision coordination. Orchestrates 8 specialist agents in sequence:

| Step | Agent | Purpose |
|---|---|---|
| 1 | `health_memory_agent` | Longitudinal FHIR history |
| 2 | `diagnosis_agent` | Clinical analysis |
| 3 | `intake_agent` | ICD-10-CM coding |
| 4 | `care_navigator_agent` | Care pathways + referrals |
| 5 | `social_barrier_agent` | SDOH screening |
| 6 | `treatment_planner_agent` | Evidence-based treatment |
| 7 | `insurance_billing_agent` | Cost, coverage, prior auth |
| 8 | `followup_adherence_agent` | Follow-up scheduling |

Final step: `assembleMediCoreReport` — synthesises all agent outputs into a single structured JSON report.

**Endpoint:** `POST https://<ngrok>.ngrok-free.dev/`

---

### Health Memory Agent

Medplum FHIR R4-powered longitudinal patient intelligence. Retrieves cross-encounter history by patient name/DOB or FHIR patient ID.

**Tools:**
- `findPatient` — lookup by name + DOB
- `getPatientMemory` — full summary for a known FHIR patient ID
- `getMemoryByNameAndDob` — combined lookup + summary in one call

**Endpoint:** `POST https://<ngrok>.ngrok-free.dev/memory`

---

## Quick start

### Prerequisites

- Node.js 20+
- An [OpenRouter](https://openrouter.ai) API key
- (Optional) A [Medplum](https://medplum.com) project for FHIR data

### 1 — Install dependencies

```bash
cd po-adk-typescript-main
npm install
```

### 2 — Configure environment

```bash
# Windows
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

Open `.env` and fill in the required values:

```env
# Required
OPENROUTER_API_KEY=sk-or-v1-...
ORCHESTRATOR_URL=https://<your-ngrok>.ngrok-free.dev

# Optional — FHIR longitudinal memory
MEDPLUM_BASE_URL=https://api.medplum.com/
MEDPLUM_CLIENT_ID=your-client-id
MEDPLUM_CLIENT_SECRET=your-client-secret
```

### 3 — Start ngrok

```bash
ngrok http 8003
```

Copy the forwarding URL (e.g. `https://slain-easing-clammy.ngrok-free.dev`) and set it as `ORCHESTRATOR_URL` in `.env`.

### 4 — Start the server

```bash
npm run dev:orchestrator
```

Leave this terminal open. Both agents start on port 8003.

```
[MediCore] Server running on port 8003
[MediCore] Orchestrator   → GET  /.well-known/agent-card.json  POST /
[MediCore] Health Memory  → GET  /memory/.well-known/agent-card.json  POST /memory
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | **Yes** | — | OpenRouter API key (`sk-or-v1-...`) |
| `OPENROUTER_MODEL` | No | `deepseek/deepseek-chat` | Any model slug from openrouter.ai |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | Override for custom OpenRouter endpoint |
| `ORCHESTRATOR_URL` | **Yes** | `http://localhost:8003` | Public ngrok URL (no trailing slash) |
| `MEDPLUM_BASE_URL` | No | — | Medplum instance URL, e.g. `https://api.medplum.com/` |
| `MEDPLUM_CLIENT_ID` | No | — | Medplum OAuth2 client ID |
| `MEDPLUM_CLIENT_SECRET` | No | — | Medplum OAuth2 client secret |
| `API_KEY_PRIMARY` | No | `my-secret-key-123` | API key for authenticated agents |
| `API_KEY_SECONDARY` | No | `another-valid-key` | Secondary API key |
| `FHIR_EXTENSION_URI` | No | — | Extension URI for per-session FHIR credentials |

> If Medplum is not configured, the health memory agent responds with "Medplum FHIR unavailable" — this is graceful, not a crash. All other agents continue to work.

---

## Running the server

### Development (recommended)

```bash
# Orchestrator + Health Memory Agent on port 8003
npm run dev:orchestrator

# All agents individually (each on its own port)
npm run dev:all
```

### Individual agents

```bash
npm run dev:diagnosis        # port 8004
npm run dev:intake           # port 8005
npm run dev:care-navigator   # port 8006
npm run dev:treatment-planner
npm run dev:insurance-billing
npm run dev:followup-adherence
npm run dev:health-memory    # port 8008 (standalone)
```

### Production (compiled)

```bash
npm run build
npm run start:orchestrator
```

---

## Connecting to Prompt Opinion

### Step 1 — Start the server and ngrok

```bash
ngrok http 8003           # terminal 1
npm run dev:orchestrator  # terminal 2
```

### Step 2 — Register agents in Prompt Opinion

Go to **Agents → External Agents → Add Connection** and add both:

| Agent | Agent Card URL |
|---|---|
| MediCore AI Orchestrator | `https://<ngrok>.ngrok-free.dev` |
| Health Memory Agent | `https://<ngrok>.ngrok-free.dev/memory` |

Prompt Opinion fetches `/.well-known/agent-card.json` from each URL automatically.

### Step 3 — Verify registration

Both agents should appear in **External Agents** without errors. The agent card check must pass (green checkmark).

> **ngrok free tier note:** The ngrok URL changes every time ngrok restarts. Re-add the agents in Prompt Opinion whenever the URL changes.

---

## Testing endpoints

### Agent cards

```bash
# Orchestrator
curl https://<ngrok>.ngrok-free.dev/.well-known/agent-card.json

# Health Memory Agent
curl https://<ngrok>.ngrok-free.dev/memory/.well-known/agent-card.json
```

### A2A message/send

```bash
# Orchestrator — simple greeting
curl -X POST https://<ngrok>.ngrok-free.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-1",
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "m1",
        "role": "user",
        "parts": [{"kind": "text", "text": "hello"}]
      }
    }
  }'

# Health Memory Agent — patient lookup
curl -X POST https://<ngrok>.ngrok-free.dev/memory \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-2",
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "m2",
        "role": "user",
        "parts": [{"kind": "text", "text": "Retrieve history for patient John Demo, DOB 1970-01-01"}]
      }
    }
  }'
```

### Compatibility probe (no LLM call)

```bash
# Returns the exact A2A response shape without invoking the LLM
curl https://<ngrok>.ngrok-free.dev/ping-a2a
curl https://<ngrok>.ngrok-free.dev/memory/ping-a2a
```

### Full smoke test script

```bash
BASE_URL=https://<ngrok>.ngrok-free.dev bash scripts/test-a2a.sh
```

---

## Shared library

```
shared/
├── env.ts              dotenv loader
├── appFactory.ts       createA2aApp() + addCatchAll() — A2A Express factory
│                       • A2A 0.3.0 compliant agent card
│                       • Pre-parse logging, raw body capture
│                       • Explicit Content-Length (no chunked encoding)
│                       • 12-second response timeout
│                       • [A2A_STEP1..10] request pipeline logs
├── agentLoop.ts        OpenRouter-based LLM loop (replaces ADK runner)
│                       • Parallel tool calls
│                       • In-process session history
│                       • 15-iteration cap
├── openRouterClient.ts OpenAI-compatible singleton for OpenRouter
├── openRouterLlm.ts    LlmAgent model adapter
├── middleware.ts       apiKeyMiddleware — X-API-Key enforcement
├── fhirHook.ts         extractFhirContext — beforeModelCallback for FHIR
├── fhirService.ts      Medplum FHIR R4 data layer
│                       • 5-minute timeline cache
│                       • 6-second timeout per FHIR call
│                       • Retry with exponential backoff
├── medplumClient.ts    Medplum OAuth2 client (5-second auth timeout)
└── tools/
    ├── index.ts        re-exports all shared tools
    └── fhir.ts         FHIR R4 query tools
```

---

## Agent card format (A2A 0.3.0)

The agent card Prompt Opinion receives:

```json
{
  "name": "Health Memory Agent",
  "description": "...",
  "url": "https://<ngrok>.ngrok-free.dev/memory",
  "version": "1.0.0",
  "protocolVersion": "0.3.0",
  "preferredTransport": "JSONRPC",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "capabilities": { "streaming": false, "pushNotifications": false },
  "skills": [],
  "supportedInterfaces": [
    {
      "url": "https://<ngrok>.ngrok-free.dev/memory",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "0.3.0"
    }
  ]
}
```

### A2A response format

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "result": {
    "kind": "message",
    "messageId": "uuid",
    "role": "agent",
    "parts": [{ "kind": "text", "text": "agent response here" }],
    "contextId": "uuid"
  }
}
```

---

## Docker

```bash
# Build and start orchestrator
docker compose up --build

# Stop
docker compose down
```

The orchestrator runs on port 8003 inside the container.

---

## Troubleshooting

### "The tool SendA2AMessage returned an error"

**Check in order:**

1. **Is the server running?**
   ```bash
   curl http://localhost:8003/health
   ```
   If not, run `npm run dev:orchestrator`.

2. **Is ngrok running?**
   Check the ngrok terminal — `Session Status: online`. If not, restart ngrok and update `ORCHESTRATOR_URL` in `.env`, then re-register agents in Prompt Opinion.

3. **Test the endpoint directly:**
   ```bash
   curl http://localhost:8003/ping-a2a
   curl http://localhost:8003/memory/ping-a2a
   ```
   Both should return a JSON-RPC success response instantly.

4. **Check server logs** — look for `[A2A_PRE_PARSE]`. If it appears, the request reached the server. If not, it's a network/ngrok issue.

---

### "Failed to parse JSON: missing required properties including 'supportedInterfaces'"

The agent card is missing the `supportedInterfaces` field. This was a known bug (fixed). Restart the server — the current `appFactory.ts` includes the correct field.

---

### Agent card is served but POST times out

The FHIR client (Medplum) may be unreachable. Each FHIR call now has a **6-second timeout** — if Medplum doesn't respond, the agent returns a graceful "FHIR unavailable" message within ~8 seconds.

If Medplum credentials are wrong:
- Check `MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID`, `MEDPLUM_CLIENT_SECRET` in `.env`
- Test manually: `curl https://api.medplum.com/health`

---

### Responses are slow for clinical queries

The orchestrator calls up to 8 specialist agents sequentially. Simple queries ("hello") respond in ~4 seconds. Complex clinical queries can take 15–25 seconds as each specialist agent runs an LLM call.

For production, consider calling specialist agents in parallel where clinically appropriate.

---

## License

MIT

---

*Built with [OpenRouter](https://openrouter.ai), [Medplum FHIR](https://medplum.com), and the [A2A protocol](https://google.github.io/A2A/). Designed for the [Prompt Opinion](https://promptopinion.ai) multi-agent healthcare platform.*
