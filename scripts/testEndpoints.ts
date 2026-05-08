/**
 * A2A endpoint smoke-test — verifies every agent's POST / endpoint
 * returns a valid JSON-RPC 2.0 response with the correct schema.
 *
 * Run: npx tsx scripts/testEndpoints.ts
 *
 * Requires all agent servers to be running locally (npm run dev:all).
 * Also tests the live ngrok URL for the orchestrator.
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';

const DIVIDER = '─'.repeat(60);

interface AgentTarget {
    name: string;
    url:  string;
    note?: string;
}

// All local agents + the public ngrok orchestrator
const AGENTS: AgentTarget[] = [
    { name: 'orchestrator (ngrok)',    url: process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:8003', note: 'public ngrok endpoint' },
    { name: 'orchestrator (local)',    url: 'http://localhost:8003' },
    { name: 'intake_agent',            url: 'http://localhost:8002' },
    { name: 'diagnosis_agent',         url: 'http://localhost:8001' },
    { name: 'care_navigator_agent',    url: 'http://localhost:8004' },
    { name: 'social_barrier_agent',    url: 'http://localhost:8009' },
    { name: 'treatment_planner_agent', url: 'http://localhost:8005' },
    { name: 'insurance_billing_agent', url: 'http://localhost:8006' },
    { name: 'followup_adherence_agent',url: 'http://localhost:8007' },
    { name: 'health_memory_agent',     url: 'http://localhost:8008' },
];

const MINIMAL_A2A_REQUEST = (contextId: string) => ({
    jsonrpc: '2.0',
    id:      `test-${Date.now()}`,
    method:  'message/send',
    params: {
        message: {
            kind:      'message',
            messageId: uuidv4(),
            role:      'user',
            parts:     [{ kind: 'text', text: 'hello' }],
            contextId,
        },
    },
});

interface Result {
    agent:       string;
    url:         string;
    cardStatus:  number | 'ERROR';
    postStatus:  number | 'ERROR' | 'TIMEOUT';
    latencyMs:   number;
    responseText: string;
    schema:      'VALID' | 'INVALID' | 'N/A';
    error?:      string;
}

async function testAgent(target: AgentTarget): Promise<Result> {
    const r: Result = {
        agent:        target.name,
        url:          target.url,
        cardStatus:   'ERROR',
        postStatus:   'ERROR',
        latencyMs:    0,
        responseText: '',
        schema:       'N/A',
    };

    // ── 1. GET /.well-known/agent-card.json ──────────────────────────────────
    try {
        const cardResp = await fetch(`${target.url}/.well-known/agent-card.json`, {
            signal: AbortSignal.timeout(5_000),
        });
        r.cardStatus = cardResp.status;
    } catch (e) {
        r.cardStatus = 'ERROR';
        r.error = `Card: ${String(e).slice(0, 80)}`;
    }

    // ── 2. POST / ─────────────────────────────────────────────────────────────
    const contextId = uuidv4();
    const body      = MINIMAL_A2A_REQUEST(contextId);
    const t0        = Date.now();

    try {
        const postResp = await fetch(`${target.url}/`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(35_000),   // 35s — test timeout
        });
        r.latencyMs  = Date.now() - t0;
        r.postStatus = postResp.status;
        const ct = postResp.headers.get('content-type') ?? '';

        if (!ct.includes('application/json')) {
            r.schema = 'INVALID';
            r.error  = `Wrong Content-Type: "${ct}"`;
            return r;
        }

        const json = await postResp.json() as Record<string, unknown>;
        r.responseText = JSON.stringify(json).slice(0, 200);

        // Validate schema
        const isValid =
            json['jsonrpc'] === '2.0' &&
            'id' in json &&
            ('result' in json || 'error' in json) &&
            (
                !('result' in json) ||
                (
                    (json['result'] as Record<string, unknown>)?.['kind'] === 'message' &&
                    (json['result'] as Record<string, unknown>)?.['role'] === 'agent' &&
                    Array.isArray((json['result'] as Record<string, unknown>)?.['parts'])
                )
            );

        r.schema = isValid ? 'VALID' : 'INVALID';

    } catch (e: unknown) {
        r.latencyMs  = Date.now() - t0;
        r.postStatus = String(e).includes('timeout') || String(e).includes('Timeout') ? 'TIMEOUT' : 'ERROR';
        r.error      = String(e).slice(0, 120);
    }

    return r;
}

async function run() {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(' MediCore A2A Endpoint Verification');
    console.log('══════════════════════════════════════════════════════════\n');

    const results = await Promise.all(AGENTS.map(testAgent));

    const working: Result[] = [];
    const failed:  Result[] = [];

    for (const r of results) {
        const cardOk = r.cardStatus === 200;
        const postOk = r.postStatus === 200 && r.schema === 'VALID';
        (cardOk && postOk ? working : failed).push(r);
    }

    // ── Working endpoints ────────────────────────────────────────────────────
    console.log(`WORKING ENDPOINTS (${working.length}/${results.length}):`);
    console.log(DIVIDER);
    for (const r of working) {
        console.log(`  ✓  ${r.agent.padEnd(32)} card=${r.cardStatus} post=${r.postStatus} schema=${r.schema} latency=${r.latencyMs}ms`);
        if (r.responseText) {
            console.log(`       response=${r.responseText.slice(0, 120)}`);
        }
    }
    if (working.length === 0) console.log('  (none)');

    // ── Failed endpoints ─────────────────────────────────────────────────────
    console.log(`\nFAILED ENDPOINTS (${failed.length}/${results.length}):`);
    console.log(DIVIDER);
    for (const r of failed) {
        const status = r.postStatus === 'TIMEOUT' ? '⏱ TIMEOUT' : r.postStatus === 'ERROR' ? '✗ ERROR' : `✗ ${r.postStatus}`;
        console.log(`  ${status}  ${r.agent.padEnd(28)} card=${r.cardStatus} post=${r.postStatus} schema=${r.schema}`);
        if (r.error) console.log(`       error: ${r.error}`);
    }
    if (failed.length === 0) console.log('  (none)');

    // ── Sample successful A2A response ───────────────────────────────────────
    const sample = working.find((r) => r.responseText);
    if (sample) {
        console.log('\nSAMPLE SUCCESSFUL A2A RESPONSE:');
        console.log(DIVIDER);
        console.log(`  Agent:    ${sample.agent}`);
        console.log(`  URL:      ${sample.url}/`);
        console.log(`  Latency:  ${sample.latencyMs}ms`);
        console.log(`  Response: ${sample.responseText}`);
    }

    // ── ngrok orchestrator summary ───────────────────────────────────────────
    const ngrok = results.find((r) => r.name.includes('ngrok'));
    if (ngrok) {
        console.log('\nNGROK ORCHESTRATOR (Prompt Opinion target):');
        console.log(DIVIDER);
        const ok = ngrok.postStatus === 200 && ngrok.schema === 'VALID';
        console.log(`  ${ok ? '✓ READY' : '✗ FAILING'}`);
        console.log(`  URL:      ${ngrok.url}/`);
        console.log(`  Card:     HTTP ${ngrok.cardStatus}`);
        console.log(`  POST:     HTTP ${ngrok.postStatus}  schema=${ngrok.schema}  latency=${ngrok.latencyMs}ms`);
        if (ngrok.responseText) console.log(`  Response: ${ngrok.responseText.slice(0, 200)}`);
        if (ngrok.error) console.log(`  Error:    ${ngrok.error}`);
    }

    console.log();
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
