/**
 * Live routing diagnostic — runs a minimal patient query through the orchestrator
 * using agentLoop (OpenRouter) directly.
 * Run: npx tsx scripts/testRouting.ts
 */

import 'dotenv/config';
import '../shared/env.js';
import { rootAgent } from '../orchestrator/agent.js';
import { getOpenRouterClient, DEFAULT_MODEL } from '../shared/openRouterClient.js';
import { runAgentLoop } from '../shared/agentLoop.js';
import { v4 as uuidv4 } from 'uuid';

const DIVIDER = '─'.repeat(60);

async function run() {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(' MediCore — Inter-Agent Routing Diagnostic (OpenRouter)');
    console.log('══════════════════════════════════════════════════════════\n');

    console.log(`Backend: OpenRouter  model=${DEFAULT_MODEL}`);
    const client = getOpenRouterClient();

    console.log('\nRegistered tools on orchestrator:');
    for (const tool of (rootAgent.tools ?? [])) {
        console.log(`  • ${tool.name}`);
    }

    const testQuery = `Patient is John Demo (DOB: 1970-01-01, FHIR ID: 191268f3-b8f9-44f3-99dc-725fcd35f8d4).
Presenting with chest pain, dizziness, and missed medications due to financial issues and transportation problems.
History: Type 2 Diabetes, Hypertension. Cardiology follow-up missed due to transportation barriers.
Please coordinate full clinical assessment and social work evaluation.`;

    console.log('\nQuery:', testQuery.slice(0, 100), '...\n');
    console.log(DIVIDER);

    const t0 = Date.now();
    const sessionId = uuidv4();

    const result = await runAgentLoop(client, DEFAULT_MODEL, rootAgent, testQuery, sessionId, {
        a2aUserText: testQuery,
        patientQuery: testQuery,
        patientId: '191268f3-b8f9-44f3-99dc-725fcd35f8d4',
        patient_id: '191268f3-b8f9-44f3-99dc-725fcd35f8d4',
    });

    const elapsed = Date.now() - t0;
    console.log(DIVIDER);
    console.log(`\nTotal elapsed: ${elapsed}ms`);
    console.log('\nFinal response (first 500 chars):');
    console.log(result.slice(0, 500));
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
