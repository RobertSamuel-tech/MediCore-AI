/**
 * Deep diagnostic for health_memory_agent — uses OpenRouter directly.
 * Run: npx tsx scripts/debugHealthMemory.ts
 */
import '../shared/env.js';
import 'dotenv/config';

// Verify OpenRouter key before anything else
const apiKey = process.env['OPENROUTER_API_KEY'];
if (!apiKey) { console.error('FATAL: OPENROUTER_API_KEY not set'); process.exit(1); }
console.log(`[env] OpenRouter key: ${apiKey.slice(0, 12)}...${apiKey.slice(-4)}  (${apiKey.length} chars)`);

import { LlmAgent, LLMRegistry } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v3';
import { getOpenRouterClient, DEFAULT_MODEL } from '../shared/openRouterClient.js';
import { runAgentLoop } from '../shared/agentLoop.js';
import { v4 as uuidv4 } from 'uuid';

const D = '─'.repeat(56);
const client = getOpenRouterClient();

async function runTest(label: string, agent: LlmAgent, text: string) {
    console.log(`\n── ${label}`);
    const t0 = Date.now();
    const result = await runAgentLoop(client, DEFAULT_MODEL, agent, text, uuidv4());
    console.log(`  events ok, latency=${Date.now()-t0}ms`);
    console.log(`  result="${result.slice(0, 150)}"`);
    console.log(`  STATUS: ${result ? '✓ PASS' : '✗ FAIL'}`);
    return result;
}

async function main() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log(' Health Memory Agent — Deep Diagnostic (OpenRouter)');
    console.log('══════════════════════════════════════════════════════');

    // TEST A: bare agent
    const bareAgent = new LlmAgent({
        name: 'bare_test', model: new OpenRouterLlm(),
        instruction: 'You are a helpful assistant. Respond concisely.',
    });
    await runTest('TEST A — Bare agent', bareAgent, 'hi');

    // TEST B: agent with one simple tool
    const echoTool = new FunctionTool({
        name: 'getPatientData', description: 'Returns patient data.',
        parameters: z.object({ patientId: z.string().describe('Patient ID') }),
        execute: async (_i: { patientId: string }) => ({
            summary: 'John Demo, 56 y/o male. Conditions: Hypertension, Type 2 Diabetes.',
        }),
    });
    const toolAgent = new LlmAgent({
        name: 'tool_test', model: new OpenRouterLlm(),
        instruction: 'When asked for patient data, call getPatientData with the patient ID.',
        tools: [echoTool],
    });
    await runTest('TEST B — Agent with tool', toolAgent, 'Get patient data for ID 191268f3');

    // TEST C: real health_memory_agent
    const { rootAgent: hma } = await import('../health_memory_agent/agent.js');
    await runTest('TEST C — Real health_memory_agent', hma, 'hi');
    await runTest('TEST D — FHIR retrieval', hma,
        'Retrieve patient memory for John Demo, patient ID 191268f3-b8f9-44f3-99dc-725fcd35f8d4');

    console.log('\n══════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
