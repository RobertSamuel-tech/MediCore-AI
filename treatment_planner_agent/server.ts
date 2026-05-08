/**
 * Treatment Planner agent — server entry point.
 *
 *   GET  /.well-known/agent-card.json   Public — always open
 *   POST /                              A2A JSON-RPC (requires X-API-Key)
 *
 * Run:
 *   npm run dev:treatment-planner
 *   # → Server live at http://localhost:8005
 *   # → Agent card: GET http://localhost:8005/.well-known/agent-card.json
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8005);
const URL = process.env['TREATMENT_PLANNER_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'treatment_planner_agent',
    description:
        'Treatment Planner — generates evidence-based treatment plans aligned with clinical ' +
        'guidelines (AHA, ADA, USPSTF) based on the clinical query.',
    url: URL,
    version: '1.0.0',
});

app.listen(PORT, () => {
    console.info(`[treatment_planner_agent] port=${PORT}`);
    console.info(`[treatment_planner_agent] card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`[treatment_planner_agent] A2A:  POST http://localhost:${PORT}/`);
});
