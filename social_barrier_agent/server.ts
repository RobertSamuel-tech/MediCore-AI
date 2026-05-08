/**
 * Social Barrier Agent — server entry point.
 *
 *   GET  /.well-known/agent-card.json   Public — agent discovery
 *   POST /                              A2A JSON-RPC
 *
 * Run:
 *   npm run dev:social-barrier
 *   # → Server live at http://localhost:8009
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8009);
const URL  = process.env['SOCIAL_BARRIER_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'Social Barrier Agent',
    description:
        'SDOH screening and social work assessment agent. Identifies transportation, ' +
        'financial, food insecurity, housing, and health literacy barriers with ' +
        'recommended community resources and care team actions.',
    url: URL,
    version: '1.0.0',
    requireApiKey: false,
});

app.listen(PORT, () => {
    console.info(`[Social Barrier Agent] running on port ${PORT}`);
    console.info(`[Social Barrier Agent] Agent card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`[Social Barrier Agent] A2A endpoint: POST http://localhost:${PORT}/`);
});
