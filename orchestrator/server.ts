/**
 * MediCore Orchestrator — server entry point.
 *
 * Architecture: single LLM call, no pre-execution.
 *
 * Flow:
 *   POST /  →  synthesizerAgent (ZERO tools)
 *              • Answers from medical knowledge + embedded demo patient
 *              • One LLM call → responds in 2–6 s
 *              • Always within Prompt Opinion's SendA2AMessage timeout
 *
 * To enable full multi-agent pre-execution (when all specialist servers are
 * running via `npm run dev:all`), uncomment the preProcessUserText line below.
 */

import 'dotenv/config';

process.on('uncaughtException', (err: Error) => {
    console.error('[UNCAUGHT_EXCEPTION]', err.stack ?? err.message);
});
process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error('[UNHANDLED_REJECTION]', msg);
});

import { createA2aApp, addCatchAll, printRoutes } from '../shared/appFactory.js';
import { rootAgent as synthesizerAgent } from './agent.js';
// import { coordinateSpecialists } from './coordinator.js';  // ← enable for full multi-agent

const PORT = Number(process.env['PORT'] ?? 8003);
const BASE = process.env['ORCHESTRATOR_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent:       synthesizerAgent,
    name:        'MediCore AI',
    description: 'Unified clinical intelligence — diagnosis, treatment planning, care navigation, ' +
                 'insurance guidance, social barrier screening, and follow-up adherence.',
    url:     BASE,
    version: '1.0.0',
    requireApiKey: false,

    // Single LLM call — no pre-execution overhead.
    // Must respond within Prompt Opinion's ~8–10 s SendA2AMessage timeout.
    // 7 s gives 1–3 s headroom.
    responseTimeoutMs: 7_000,

    // Uncomment to enable server-side specialist pre-execution (requires dev:all):
    // preProcessUserText: coordinateSpecialists,
    // responseTimeoutMs:  25_000,
});

addCatchAll(app, 'MediCore AI');

app.listen(PORT, () => {
    console.info('');
    console.info('╔══════════════════════════════════════════════════════════╗');
    console.info('║           MediCore AI — Started                          ║');
    console.info('╚══════════════════════════════════════════════════════════╝');
    console.info('');
    console.info('  Mode: single-LLM synthesis (fast, no pre-execution)');
    console.info('  Demo patient: John Demo (3057d34b) — embedded in instruction');
    console.info('');
    console.info(`  Port  : ${PORT}`);
    console.info(`  Base  : ${BASE}`);
    console.info('');
    if (BASE.includes('localhost')) {
        console.info('  ⚠  ORCHESTRATOR_URL not set — agent card will advertise localhost.');
        console.info('     Set ORCHESTRATOR_URL=https://<ngrok>.ngrok-free.app in .env');
        console.info('');
    }
    console.info('  Prompt Opinion — register this URL:');
    console.info(`    ${BASE}`);
    console.info('');
    printRoutes(app, PORT);
    console.info('');
    console.info('  Test queries that work immediately:');
    console.info('    • "What can you do?"');
    console.info('    • "Analyze cardiovascular risk for John Demo"');
    console.info('    • "Generate ICD-10 codes for John Demo"');
    console.info('    • "Create treatment plan for diabetes"');
    console.info('    • "Check insurance billing considerations"');
    console.info('    • "Identify social barriers for medication adherence"');
    console.info('');
    console.info('  Expected timing:');
    console.info('    [REQ] POST /  →  [A2A_INBOUND]  →  LLM (2-6s)  →  [A2A_OUTBOUND]');
    console.info('');
});
