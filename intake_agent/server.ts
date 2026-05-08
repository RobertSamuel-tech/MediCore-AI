/**
 * Intake agent — server entry point.
 *
 * Renamed from general_agent/server.ts.
 *
 *   GET  /.well-known/agent-card.json   Public — always open
 *   POST /                              A2A JSON-RPC (no auth required)
 *
 * Run:
 *   npm run dev:intake
 *   # → Server live at http://localhost:8002
 *   # → Agent card: GET http://localhost:8002/.well-known/agent-card.json
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8002);
const URL = process.env['INTAKE_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'Intake Agent',
    description: 'Clinical intake agent — collects initial patient information, date/time queries, and ICD-10-CM code lookups.',
    url: URL,
    version: '1.0.0',
    requireApiKey: false,
});

app.listen(PORT, () => {
    console.info(`intake_agent running on port ${PORT}`);
    console.info(`Agent card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`A2A endpoint: POST http://localhost:${PORT}/`);
});
