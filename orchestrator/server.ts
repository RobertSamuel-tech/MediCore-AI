/**
 * MediCore Orchestrator — server entry point.
 *
 * Single Express server on port 8003, exposed via ngrok.
 * Serves TWO A2A agents under different paths so only ONE tunnel is needed:
 *
 *   / (root)      → MediCore AI Orchestrator
 *   /memory       → Health Memory Agent (Medplum FHIR)
 *
 * Endpoints per agent:
 *   GET  {base}/.well-known/agent-card.json   Agent card for Prompt Opinion
 *   POST {base}/                               A2A JSON-RPC
 *   GET  {base}/health                         Liveness probe
 *
 * Prompt Opinion registrations:
 *   MediCore AI Orchestrator → https://<ngrok>
 *   Health Memory Agent      → https://<ngrok>/memory
 *
 * Run:
 *   npm run dev:orchestrator
 *   # → http://localhost:8003        (orchestrator)
 *   # → http://localhost:8003/memory (health_memory_agent)
 */

import 'dotenv/config';

// ── Global error handlers (must be first) ──────────────────────────────────────
// Print full stack traces so every crash is visible in the terminal.
process.on('uncaughtException', (err: Error) => {
    console.error('[UNCAUGHT_EXCEPTION]', err.stack ?? err.message);
    // Don't exit — keep the server alive so Prompt Opinion can retry.
});

process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error('[UNHANDLED_REJECTION]', msg);
});

import { createA2aApp, addCatchAll } from '../shared/appFactory.js';
import { rootAgent as orchestratorAgent }  from './agent.js';
import { rootAgent as healthMemoryAgent }  from '../health_memory_agent/agent.js';

const PORT = Number(process.env['PORT'] ?? 8003);
const BASE = process.env['ORCHESTRATOR_URL'] ?? `http://localhost:${PORT}`;

// ── Orchestrator (root path) ───────────────────────────────────────────────────
const app = createA2aApp({
    agent: orchestratorAgent,
    name: 'MediCore AI',
    description:
        'Enterprise clinical decision coordination platform. ' +
        'Orchestrates 7 specialist agents — longitudinal health memory, clinical diagnosis, ' +
        'ICD-10 intake coding, care navigation, evidence-based treatment planning, ' +
        'affordability-aware insurance billing, and follow-up adherence intelligence — ' +
        'over an interoperable A2A multi-agent architecture.',
    url: BASE,
    version: '1.0.0',
    requireApiKey: false,
});

// ── Health Memory Agent (/memory sub-path) ────────────────────────────────────
// Mounted as a sub-app so it shares the same ngrok tunnel.
// Prompt Opinion registers this agent at: https://<ngrok>/memory
// Express strips the /memory prefix before delegating to the sub-app,
// so the sub-app sees GET /.well-known/agent-card.json and POST / as normal.
const MEMORY_PATH   = '/memory';
const MEMORY_URL    = `${BASE}${MEMORY_PATH}`;

const healthMemoryApp = createA2aApp({
    agent: healthMemoryAgent,
    name: 'Health Memory Agent',
    description:
        'Medplum FHIR R4-powered longitudinal patient memory. ' +
        'Retrieves cross-encounter health history — conditions, medications, allergies, ' +
        'vitals, labs, and pending referrals — by patient name/DOB or FHIR patient ID.',
    url: MEMORY_URL,
    version: '1.0.0',
    requireApiKey: false,
});

// IMPORTANT: sub-app mount MUST come before addCatchAll so /memory/* routes
// are handled by healthMemoryApp and do not fall into the 404 handler.
app.use(MEMORY_PATH, healthMemoryApp);

// Catch-all 404 — registered last so sub-app routes are matched first.
addCatchAll(app, 'MediCore AI + Health Memory Agent');

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.info(`[MediCore] Server running on port ${PORT}`);
    console.info(`[MediCore] Orchestrator`);
    console.info(`  Card : GET  http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`  A2A  : POST http://localhost:${PORT}/`);
    console.info(`[MediCore] Health Memory Agent  (path: ${MEMORY_PATH})`);
    console.info(`  Card : GET  http://localhost:${PORT}${MEMORY_PATH}/.well-known/agent-card.json`);
    console.info(`  A2A  : POST http://localhost:${PORT}${MEMORY_PATH}/`);
    console.info(`[MediCore] Public base URL: ${BASE}`);
    console.info(`[MediCore] Health Memory public URL: ${MEMORY_URL}`);
    console.info(`[MediCore] → Register Health Memory Agent in Prompt Opinion with URL: ${MEMORY_URL}`);
    console.info('');
    console.info('[MediCore] Quick test commands:');
    console.info(`  curl http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`  curl http://localhost:${PORT}${MEMORY_PATH}/.well-known/agent-card.json`);
    console.info(`  curl -X POST http://localhost:${PORT}/ -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":"test-1","method":"message/send","params":{"message":{"messageId":"m1","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'`);
    console.info(`  curl -X POST http://localhost:${PORT}${MEMORY_PATH}/ -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":"test-2","method":"message/send","params":{"message":{"messageId":"m2","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'`);
});
