/**
 * OpenRouter-based agentic loop.
 *
 * Replaces @google/adk's Runner for all LLM execution.
 * Uses the OpenAI-compatible API via OpenRouter, handles parallel tool calls,
 * maintains in-process session history, and captures assembleMediCoreReport
 * output directly if the LLM doesn't echo it as text (some models skip the echo).
 */

import './env.js';

import type OpenAI from 'openai';
import type { LlmAgent } from '@google/adk';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ── Internal types ─────────────────────────────────────────────────────────────

// FunctionTool's execute is private in TS types — cast to access at runtime.
interface ToolLike {
    name: string;
    description?: string;
    execute: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
    parameters?: unknown;
}

// ── Tool schema conversion ─────────────────────────────────────────────────────

function toJsonSchema(zodSchema: unknown): Record<string, unknown> {
    if (!zodSchema) return { type: 'object', properties: {} };
    try {
        const full = zodToJsonSchema(zodSchema as Parameters<typeof zodToJsonSchema>[0], {
            target: 'openApi3',
        }) as Record<string, unknown>;
        const { $schema: _s, title: _t, definitions: _d, ...clean } = full;
        return clean;
    } catch {
        return { type: 'object', properties: {} };
    }
}

function agentToOpenAITools(agent: LlmAgent): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return (agent.tools ?? [])
        .map((t) => t as unknown as ToolLike)
        .filter((t) => !!t && typeof t.name === 'string' && typeof t.execute === 'function')
        .map((t) => ({
            type: 'function' as const,
            function: {
                name:        t.name,
                description: t.description ?? t.name,
                parameters:  toJsonSchema(t.parameters),
            },
        }));
}

// ── In-process session store ───────────────────────────────────────────────────

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
interface Session { messages: Msg[] }

const _sessions = new Map<string, Session>();
const SESSION_MAX = 40;

function getSession(key: string): Session {
    if (!_sessions.has(key)) _sessions.set(key, { messages: [] });
    return _sessions.get(key)!;
}

// ── Mock ToolContext ───────────────────────────────────────────────────────────
// Gives FHIR tools and Medplum tools access to stateDelta values without ADK sessions.

function mockCtx(state: Map<string, unknown>) {
    return {
        state: {
            get: (k: string) => state.get(k),
            set: (k: string, v: unknown) => { state.set(k, v); },
            has: (k: string) => state.has(k),
        },
        actions: { stateDelta: {} },
    };
}

// ── Core loop ──────────────────────────────────────────────────────────────────

const MAX_ITER = 15;
// 5 s hard cap per LLM call.
// The orchestrator sets responseTimeoutMs = 7 s, so a 5 s LLM abort +
// fallback write easily fits within Prompt Opinion's 8–10 s budget.
const LLM_CALL_TIMEOUT_MS = 5_000;

export async function runAgentLoop(
    client: OpenAI,
    model: string,
    agent: LlmAgent,
    userText: string,
    sessionId: string,
    stateDelta: Record<string, unknown> = {},
): Promise<string> {
    const key     = `${agent.name}:${sessionId}`;
    const session = getSession(key);
    const state   = new Map<string, unknown>(Object.entries(stateDelta));
    const tools   = agentToOpenAITools(agent);
    const ctx     = mockCtx(state);

    session.messages.push({ role: 'user', content: userText });
    if (session.messages.length > SESSION_MAX) {
        session.messages.splice(0, session.messages.length - SESSION_MAX);
    }

    // Resolve instruction — can be a string or a function in ADK
    const instruction = typeof agent.instruction === 'function'
        ? (agent.instruction as () => string)()
        : (agent.instruction ?? 'You are a helpful AI assistant.');

    const messages: Msg[] = [
        { role: 'system', content: instruction },
        ...session.messages,
    ];

    let finalText  = '';
    let reportText = '';

    for (let i = 0; i < MAX_ITER; i++) {
        let completion: OpenAI.Chat.Completions.ChatCompletion;
        try {
            const controller = new AbortController();
            const llmTimer   = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
            try {
                completion = await client.chat.completions.create(
                    {
                        model,
                        messages,
                        tools:       tools.length ? tools : undefined,
                        tool_choice: tools.length ? 'auto' : undefined,
                        temperature: 0.1,
                        max_tokens:  8192,
                    },
                    { signal: controller.signal },
                );
            } finally {
                clearTimeout(llmTimer);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[agentLoop] API error agent=${agent.name} iter=${i}: ${msg}`);
            if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
                return 'I am temporarily unavailable due to API rate limiting. Please retry in a moment.';
            }
            // AbortError from our timeout — surface as a clean message so the
            // outer 7 s response timeout can return it gracefully.
            if (err instanceof Error && err.name === 'AbortError') {
                throw new Error(`LLM call timed out after ${LLM_CALL_TIMEOUT_MS}ms — OpenRouter is slow, please retry`);
            }
            throw err;
        }

        const choice = completion.choices[0];
        if (!choice) break;

        const assistantMsg = choice.message as OpenAI.Chat.Completions.ChatCompletionMessage;
        messages.push(assistantMsg as Msg);

        // ── Tool calls ─────────────────────────────────────────────────────────
        if ((choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') &&
            assistantMsg.tool_calls?.length) {

            const toolResults: Msg[] = await Promise.all(
                assistantMsg.tool_calls.map(async (tc) => {
                    // tc.function is standard; handle custom tool call shapes via cast
                    const tcAny     = tc as unknown as Record<string, unknown>;
                    const fnField   = (tcAny['function'] ?? tcAny) as Record<string, unknown>;
                    const toolName  = String(fnField['name'] ?? '');
                    const argsRaw   = String(fnField['arguments'] ?? '{}');
                    const tcId      = String(tcAny['id'] ?? `tc-${Date.now()}`);

                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(argsRaw); } catch {}

                    const tool = (agent.tools ?? []).map(t => t as unknown as ToolLike).find((t) => t.name === toolName);
                    let result: unknown;

                    if (tool?.execute) {
                        try {
                            result = await tool.execute(args, ctx);
                        } catch (err) {
                            const m = err instanceof Error ? err.message : String(err);
                            console.error(`[agentLoop] tool=${toolName} threw: ${m}`);
                            result = { status: 'error', error: m };
                        }

                        // Direct capture of assembleMediCoreReport output
                        if (toolName === 'assembleMediCoreReport') {
                            const r = result as Record<string, unknown> | undefined;
                            if (typeof r?.['report'] === 'string' && r['report'].trim()) {
                                reportText = r['report'];
                                console.info(`[agentLoop] assembleMediCoreReport captured (${reportText.length} chars)`);
                            }
                        }
                    } else {
                        console.warn(`[agentLoop] tool "${toolName}" not found in ${agent.name}`);
                        result = { status: 'error', agent: toolName, reason: `Tool ${toolName} not found`, fallback: `${toolName} is not available — skip and continue.` };
                    }

                    return {
                        role:         'tool' as const,
                        tool_call_id: tcId,
                        content:      typeof result === 'string' ? result : JSON.stringify(result),
                    };
                }),
            );

            messages.push(...toolResults);
            continue;
        }

        // ── Final text ─────────────────────────────────────────────────────────
        finalText = assistantMsg.content ?? '';
        break;
    }

    const result = finalText.trim() || reportText;

    if (result) {
        session.messages.push({ role: 'assistant', content: result });
    } else {
        console.warn(`[agentLoop] Empty response agent=${agent.name} session=${sessionId}`);
    }

    return result;
}
