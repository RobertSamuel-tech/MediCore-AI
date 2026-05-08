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

const FHIR_EXTENSION = process.env['FHIR_EXTENSION_URI'] ?? 'http://localhost:5139/schemas/a2a/v1/fhir-context';

const app = createA2aApp({
    agent: rootAgent,
    name: 'diagnosis_agent',
    description: (
        "A clinical diagnosis assistant that queries a patient's FHIR health record to analyze " +
        'conditions, medications, observations, and care history to support diagnostic reasoning.'
    ),
    url: URL,
    version: '1.0.0',
    fhirExtensionUri: FHIR_EXTENSION,
    requireApiKey: true,
});

app.listen(PORT, () => {
    console.info(`diagnosis_agent running on port ${PORT}`);
    console.info(`Agent card: GET http://localhost:${PORT}/.well-known/agent-card.json`);
    console.info(`A2A endpoint: POST http://localhost:${PORT}/  (X-API-Key required)`);
});
