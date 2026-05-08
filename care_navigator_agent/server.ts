/**
 * Care Navigator agent — server entry point.
 *
 *   GET  /.well-known/agent-card.json   Public — always open
 *   POST /                              A2A JSON-RPC (requires X-API-Key)
 *
 * Run:
 *   npm run dev:care-navigator
 *   # → Server live at http://localhost:8004
 *   # → Agent card: GET http://localhost:8004/.well-known/agent-card.json
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8004);
const URL = process.env['CARE_NAVIGATOR_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'care_navigator_agent',
    description:
        'Care Navigator — identifies care pathways, coordinates referrals, and manages ' +
        'care transitions based on the clinical query.',
    url: URL,
    version: '1.0.0',
});

app.listen(PORT, () => {
    console.info(`[care_navigator_agent] port=${PORT}`);
    console.info(`[care_navigator_agent] card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`[care_navigator_agent] A2A:  POST http://localhost:${PORT}/`);
});
