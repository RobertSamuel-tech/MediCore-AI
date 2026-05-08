/**
 * A2A endpoint probe — tests orchestrator root + health_memory_agent sub-path.
 * Run: npx tsx scripts/probeOrchestrator.ts
 */
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';

const BASE   = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:8003';
const MEMORY = `${BASE}/memory`;
const D = '═'.repeat(58);

async function getCard(url: string) {
    const r = await fetch(`${url}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(8_000) });
    return { status: r.status, body: await r.json() as Record<string,unknown> };
}

async function postMessage(url: string, text: string, label: string) {
    const t0 = Date.now();
    const body = {
        jsonrpc: '2.0', id: `probe-${Date.now()}`, method: 'message/send',
        params: { message: { kind: 'message', messageId: uuidv4(), role: 'user',
            parts: [{ kind: 'text', text }], contextId: uuidv4() } },
    };
    const r = await fetch(`${url}/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(35_000),
    });
    const latency = Date.now() - t0;
    const json = await r.json() as Record<string,unknown>;
    const result = json['result'] as Record<string,unknown> | undefined;
    const responseText = ((result?.['parts'] ?? []) as {text:string}[]).map(p=>p.text).join('') ||
                         (json['error'] ? `ERROR: ${JSON.stringify(json['error'])}` : '(empty)');
    const ok = r.status === 200 && responseText && responseText !== '(no response)' && !responseText.startsWith('(');
    console.log(`  ${ok?'✓':'✗'}  [${label}] HTTP ${r.status}  latency=${latency}ms`);
    console.log(`     response: "${responseText.slice(0, 200)}"`);
    return { ok, status: r.status, latency, text: responseText };
}

async function run() {
    console.log(`\n${D}`);
    console.log(` MediCore A2A Endpoint Probe`);
    console.log(`${D}\n`);

    // ── Orchestrator ─────────────────────────────────────────────────────────
    console.log(`ORCHESTRATOR  →  ${BASE}`);
    console.log(`─`.repeat(50));

    try {
        const { status, body } = await getCard(BASE);
        const ok = status === 200;
        console.log(`  ${ok?'✓':'✗'}  Agent card: HTTP ${status}  name="${body['name']}"  url="${body['url']}"`);
    } catch(e) { console.log(`  ✗  Agent card: ERROR ${e}`); }

    await postMessage(BASE, 'hi', 'simple greeting');

    // ── Health Memory Agent ───────────────────────────────────────────────────
    console.log(`\nHEALTH MEMORY AGENT  →  ${MEMORY}`);
    console.log(`─`.repeat(50));

    try {
        const { status, body } = await getCard(MEMORY);
        const ok = status === 200;
        console.log(`  ${ok?'✓':'✗'}  Agent card: HTTP ${status}  name="${body['name']}"  url="${body['url']}"`);
        if (ok) {
            console.log(`\n  ⚑  Register this in Prompt Opinion for the health_memory_agent connection:`);
            console.log(`     Agent URL: ${MEMORY}`);
        }
    } catch(e) { console.log(`  ✗  Agent card: ERROR ${e}`); }

    await postMessage(MEMORY, 'hi', 'simple greeting');

    const fhirResult = await postMessage(
        MEMORY,
        'Retrieve patient memory for John Demo, patient ID 191268f3-b8f9-44f3-99dc-725fcd35f8d4. Include Conditions, Medications, and any active referrals.',
        'FHIR memory retrieval',
    );

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${D}`);
    console.log(` SUMMARY`);
    console.log(`${D}`);
    console.log(`  Orchestrator base URL  : ${BASE}`);
    console.log(`  Health Memory URL      : ${MEMORY}`);
    console.log(`  Memory retrieval OK    : ${fhirResult.ok ? 'YES ✓' : 'NO ✗'}`);
    console.log();
    console.log(`  → In Prompt Opinion, update the health_memory_agent connection URL to:`);
    console.log(`    ${MEMORY}`);
    console.log();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
