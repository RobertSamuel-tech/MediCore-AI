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

const FHIR_EXTENSION = process.env['FHIR_EXTENSION_URI'] ?? 'http://localhost:5139/schemas/a2a/v1/fhir-context';

const app = createA2aApp({
    agent: rootAgent,
    name: 'insurance_billing_agent',
    description: (
        'A healthcare insurance and billing specialist that handles eligibility verification, ' +
        'prior authorisation, claims generation, and denial management.'
    ),
    url: URL,
    version: '1.0.0',
    fhirExtensionUri: FHIR_EXTENSION,
    requireApiKey: true,
});

app.listen(PORT, () => {
    console.info(`insurance_billing_agent running on port ${PORT}`);
    console.info(`Agent card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`A2A endpoint: POST http://localhost:${PORT}/  (X-API-Key required)`);
});
