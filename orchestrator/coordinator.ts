/**
 * MediCore server-side coordinator.
 *
 * Calls specialist agents via real HTTP A2A requests BEFORE the synthesizer
 * LLM runs.  The synthesizer sees the pre-collected outputs as plain context —
 * it has no tools and never triggers Prompt Opinion's SendA2AMessage.
 *
 * Architecture:
 *   Orchestrator (8003)
 *     ├─ POST http://localhost:8001/  → diagnosis_agent
 *     ├─ POST http://localhost:8004/  → care_navigator_agent
 *     ├─ POST http://localhost:8005/  → treatment_planner_agent
 *     ├─ POST http://localhost:8007/  → followup_adherence_agent
 *     └─ POST http://localhost:8009/  → social_barrier_agent
 *   All calls run in PARALLEL.  Failures are silent (no context for that domain).
 *   Synthesizer LLM then produces ONE clean prose response.
 *
 * When running only `npm run dev:orchestrator` (specialists offline):
 *   All A2A calls fail with ECONNREFUSED → coordinator returns the raw query
 *   unchanged → synthesizer responds from its own clinical knowledge.
 *
 * For full multi-agent mode: `npm run dev:all`
 */

import '../shared/env.js';
import { v4 as uuidv4 } from 'uuid';

// ── Agent registry — reads URLs from .env, falls back to localhost defaults ────

const AGENTS = {
    diagnosis:      process.env['DIAGNOSIS_AGENT_URL']         ?? 'http://localhost:8001',
    intake:         process.env['INTAKE_AGENT_URL']            ?? 'http://localhost:8002',
    careNavigator:  process.env['CARE_NAVIGATOR_AGENT_URL']    ?? 'http://localhost:8004',
    treatment:      process.env['TREATMENT_PLANNER_AGENT_URL'] ?? 'http://localhost:8005',
    billing:        process.env['INSURANCE_BILLING_AGENT_URL'] ?? 'http://localhost:8006',
    followup:       process.env['FOLLOWUP_ADHERENCE_AGENT_URL'] ?? 'http://localhost:8007',
    social:         process.env['SOCIAL_BARRIER_AGENT_URL']    ?? 'http://localhost:8009',
} as const;

// 12 s per specialist — they run in PARALLEL so total wall-clock ≈ slowest agent
const SPECIALIST_TIMEOUT_MS = 12_000;

// ── Greeting detection ─────────────────────────────────────────────────────────

const GREETING_PATTERNS = [
    /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy)\s*[!?.]?\s*$/i,
    /^\s*how are you\s*[?.]?\s*$/i,
    /^\s*what can you do\s*[?.]?\s*$/i,
    /^\s*what('?s| is) medicore\s*[?.]?\s*$/i,
    /^\s*(help|capabilities|features)\s*[?.]?\s*$/i,
];

function isGreeting(text: string): boolean {
    return GREETING_PATTERNS.some(p => p.test(text.trim()));
}

// ── A2A HTTP call ──────────────────────────────────────────────────────────────

interface A2APart { kind: string; text?: string }
interface A2AResult { kind?: string; parts?: A2APart[] }
interface A2AResponse { result?: A2AResult; error?: { message?: string } }

async function callA2AAgent(
    agentUrl: string,
    agentLabel: string,
    query: string,
): Promise<string | null> {
    const t0 = Date.now();

    try {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id:      uuidv4(),
            method:  'message/send',
            params:  {
                message: {
                    messageId: uuidv4(),
                    role:      'user',
                    contextId: uuidv4(),
                    parts:     [{ kind: 'text', text: query }],
                },
            },
        });

        const response = await fetch(agentUrl, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/json',
            },
            body,
            signal: AbortSignal.timeout(SPECIALIST_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const json = await response.json() as A2AResponse;

        if (json.error) {
            throw new Error(String(json.error.message ?? 'A2A error'));
        }

        const parts = json.result?.parts ?? [];
        const text  = parts
            .filter(p => p.kind === 'text' && p.text)
            .map(p => p.text!)
            .join('\n')
            .trim();

        if (!text) {
            console.warn(`[COORDINATOR][EMPTY] ${agentLabel} returned no text`);
            return null;
        }

        const ms = Date.now() - t0;
        console.log(`[COORDINATOR][A2A_OK] ${agentLabel} latency=${ms}ms len=${text.length}`);
        return text;

    } catch (err: unknown) {
        const ms  = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        const tag = msg.includes('ECONNREFUSED') || msg.includes('fetch') ? 'OFFLINE'
                  : msg.includes('timeout') || msg.includes('abort') || msg.includes('Abort') ? 'TIMEOUT'
                  : 'ERROR';
        console.error(`[COORDINATOR][A2A_${tag}] ${agentLabel} latency=${ms}ms reason="${msg}"`);
        return null;
    }
}

// ── Query routing ──────────────────────────────────────────────────────────────
// Returns the set of agents most relevant to the query.

interface AgentSpec { label: string; url: string }

function selectAgents(query: string): AgentSpec[] {
    const q = query.toLowerCase();

    // Billing / insurance focused
    if (/insurance|billing|coverage|prior.auth|copay|claim|cpt|hcpcs|cost|payment/.test(q) &&
        !/diagnos|treatment|risk|care.plan|social/.test(q)) {
        return [{ label: 'Insurance & Billing', url: AGENTS.billing }];
    }

    // ICD / coding focused
    if (/\bicd(-10)?\b|diagnostic.code|billing.code|code.for/.test(q) &&
        !/treatment|care.plan|risk|social/.test(q)) {
        return [
            { label: 'Intake & ICD-10', url: AGENTS.intake },
            { label: 'Clinical Diagnosis', url: AGENTS.diagnosis },
        ];
    }

    // Social barriers focused
    if (/social.barrier|sdoh|transportation|food.insecurity|housing|health.literacy|financial.barrier/.test(q) &&
        !/diagnos|treatment|risk|care.plan/.test(q)) {
        return [{ label: 'Social Barriers', url: AGENTS.social }];
    }

    // Full clinical query — run core clinical set in parallel
    return [
        { label: 'Clinical Diagnosis',    url: AGENTS.diagnosis },
        { label: 'Treatment Planning',    url: AGENTS.treatment },
        { label: 'Care Navigation',       url: AGENTS.careNavigator },
        { label: 'Follow-up & Adherence', url: AGENTS.followup },
        { label: 'Social Barriers',       url: AGENTS.social },
    ];
}

// ── Context builder ────────────────────────────────────────────────────────────

function buildContext(
    query:   string,
    results: Array<{ label: string; output: string | null }>,
): string {
    const available = results.filter(r => r.output !== null);

    if (available.length === 0) {
        // No specialists responded — return raw query so synthesizer
        // answers from its own clinical knowledge
        return query;
    }

    const lines: string[] = [
        '<CLINICAL_ANALYSIS>',
        `Query: ${query}`,
        '',
    ];

    for (const { label, output } of available) {
        lines.push(`=== ${label} ===`);
        lines.push(output!);
        lines.push('');
    }

    lines.push('</CLINICAL_ANALYSIS>');
    lines.push('');
    lines.push(`User question: ${query}`);

    return lines.join('\n');
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Pre-processes the user query by calling relevant specialist agents via A2A.
 * Returns enriched context for the synthesizer LLM.
 *
 * - Greetings → returns the original text (no specialist calls)
 * - Clinical queries → runs specialists in parallel, builds context
 * - Offline specialists → silently skipped (context uses only available outputs)
 */
export async function coordinateSpecialists(userText: string): Promise<string> {
    if (isGreeting(userText)) {
        console.log(`[COORDINATOR] Greeting detected — skipping specialist calls`);
        return userText;
    }

    const specs = selectAgents(userText);
    const labels = specs.map(s => s.label).join(', ');
    console.log(`[COORDINATOR] Dispatching to ${specs.length} specialist(s) via A2A: [${labels}]`);

    const settled = await Promise.allSettled(
        specs.map(s => callA2AAgent(s.url, s.label, userText)),
    );

    const results = specs.map((s, i) => ({
        label:  s.label,
        output: settled[i]?.status === 'fulfilled'
            ? (settled[i] as PromiseFulfilledResult<string | null>).value
            : null,
    }));

    const ok = results.filter(r => r.output !== null).length;
    console.log(`[COORDINATOR] ${ok}/${specs.length} specialist(s) responded`);

    return buildContext(userText, results);
}
