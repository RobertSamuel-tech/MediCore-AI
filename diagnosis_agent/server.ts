/**
 * Diagnosis agent — server entry point.
 *
 * Renamed from healthcare_agent/server.ts.
 *
 *   GET  /.well-known/agent-card.json   Public — always open
 *   POST /                              A2A JSON-RPC (requires X-API-Key)
 *
 * Run:
 *   npm run dev:diagnosis
 *   # → Server live at http://localhost:8001
 *   # → Agent card: GET http://localhost:8001/.well-known/agent-card.json
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8001);
const URL = process.env['DIAGNOSIS_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'diagnosis_agent',
    description:
        'Clinical diagnosis specialist — analyses patient queries to assess conditions, ' +
        'urgency, ICD-10 codes, and clinical concerns using evidence-based reasoning.',
    url: URL,
    version: '1.0.0',
});

app.listen(PORT, () => {
    console.info(`[diagnosis_agent] port=${PORT}`);
    console.info(`[diagnosis_agent] card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`[diagnosis_agent] A2A:  POST http://localhost:${PORT}/`);
});
