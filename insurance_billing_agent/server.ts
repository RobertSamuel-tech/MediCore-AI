/**
 * Insurance & Billing agent — server entry point.
 *
 *   GET  /.well-known/agent-card.json   Public — always open
 *   POST /                              A2A JSON-RPC (requires X-API-Key)
 *
 * Run:
 *   npm run dev:insurance-billing
 *   # → Server live at http://localhost:8006
 *   # → Agent card: GET http://localhost:8006/.well-known/agent-card.json
 */

import 'dotenv/config';

import { createA2aApp } from '../shared/appFactory.js';
import { rootAgent } from './agent.js';

const PORT = Number(process.env['PORT'] ?? 8006);
const URL = process.env['INSURANCE_BILLING_AGENT_URL'] ?? `http://localhost:${PORT}`;

const app = createA2aApp({
    agent: rootAgent,
    name: 'insurance_billing_agent',
    description:
        'Insurance & Billing specialist — eligibility guidance, prior auth, cost estimation, ' +
        'and affordability recommendations for clinical queries.',
    url: URL,
    version: '1.0.0',
});

app.listen(PORT, () => {
    console.info(`[insurance_billing_agent] port=${PORT}`);
    console.info(`[insurance_billing_agent] card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`[insurance_billing_agent] A2A:  POST http://localhost:${PORT}/`);
});
