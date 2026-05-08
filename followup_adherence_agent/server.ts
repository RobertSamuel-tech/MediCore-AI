/**
 * Follow-up & Adherence agent — server entry point.
 *
 *   GET  /.well-known/agent-card.json   Public — always open
 *   POST /                              A2A JSON-RPC (requires X-API-Key)
 *
 * Run:
 *   npm run dev:followup-adherence
 *   # → Server live at http://localhost:8007
 *   # → Agent card: GET http://localhost:8007/.well-known/agent-card.json
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8007);
const URL = process.env['FOLLOWUP_ADHERENCE_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'followup_adherence_agent',
    description:
        'Follow-up & Adherence specialist — follow-up schedules, adherence monitoring, ' +
        'and proactive patient outreach recommendations.',
    url: URL,
    version: '1.0.0',
});

app.listen(PORT, () => {
    console.info(`[followup_adherence_agent] port=${PORT}`);
    console.info(`[followup_adherence_agent] card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`[followup_adherence_agent] A2A:  POST http://localhost:${PORT}/`);
});
