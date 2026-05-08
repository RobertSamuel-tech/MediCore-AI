/**
 * Health memory agent isolation test using OpenRouter + agentLoop.
 * Run: npx tsx scripts/testHealthMemory.ts
 */
import '../shared/env.js';
import 'dotenv/config';
import { rootAgent as hma } from '../health_memory_agent/agent.js';
import { getOpenRouterClient, DEFAULT_MODEL } from '../shared/openRouterClient.js';
import { runAgentLoop } from '../shared/agentLoop.js';
import { v4 as uuidv4 } from 'uuid';

const D = '─'.repeat(56);

async function test(label: string, text: string) {
    console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 54 - label.length))}`);
    const client = getOpenRouterClient();
    const t0 = Date.now();
    const result = await runAgentLoop(client, DEFAULT_MODEL, hma, text, uuidv4());
    console.log(`  latency: ${Date.now()-t0}ms`);
    console.log(`  result:  "${result.slice(0, 200)}"`);
    return result;
}

async function run() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log(' Health Memory Agent — OpenRouter Test');
    console.log(`  model=${DEFAULT_MODEL}`);
    console.log('══════════════════════════════════════════════════════');

    await test('Greeting', 'hi');
    await test('FHIR retrieval',
        'Retrieve patient memory for John Demo, patient ID 191268f3-b8f9-44f3-99dc-725fcd35f8d4. Include Conditions and Medications.');

    console.log('\n══════════════════════════════════════════════════════\n');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
