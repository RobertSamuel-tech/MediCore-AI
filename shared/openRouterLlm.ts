/**
 * OpenRouterLlm — custom BaseLlm that routes ALL ADK LLM calls through OpenRouter.
 *
 * Solves the ADK dev-UI rate-limit problem: the dev-UI bypasses agentLoop.ts and
 * invokes the ADK runner directly. By passing an OpenRouterLlm **instance** (not a
 * string) to LlmAgent.model, the runner calls OpenRouterLlm.generateContentAsync
 * instead of resolving the string through LLMRegistry → Google Gemini.
 *
 * Content format bridging
 * ───────────────────────
 *  GenAI (ADK)                 OpenAI (OpenRouter)
 *  role: 'user'                role: 'user'
 *  role: 'model' + text        role: 'assistant' + content
 *  role: 'model' + funcCall    role: 'assistant' + tool_calls
 *  role: 'user'  + funcResp    role: 'tool' (matched by function name)
 *  systemInstruction: string   messages[0] = { role:'system', content }
 *
 *  GenAI schema types are UPPERCASE ("OBJECT","STRING") — converted to lowercase
 *  for OpenAI compatibility before sending.
 */

import './env.js';

import { BaseLlm, LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';
import type OpenAI from 'openai';

import { getOpenRouterClient, DEFAULT_MODEL } from './openRouterClient.js';

// ── Schema conversion: GenAI UPPERCASE → OpenAI lowercase ─────────────────────

function normaliseSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(normaliseSchema);

    const src = schema as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
        if (k === 'type' && typeof v === 'string') {
            out[k] = v.toLowerCase();            // "OBJECT" → "object"
        } else if (k === 'additionalProperties') {
            // Some models reject additionalProperties: false in tool schemas
            // omit it entirely
        } else if (typeof v === 'object' && v !== null) {
            out[k] = normaliseSchema(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ── Tool schema builder ────────────────────────────────────────────────────────

type AnyTool = { _getDeclaration?(): unknown };

function toolsToOpenAI(toolsDict: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletionTool[] {
    const result: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    for (const tool of Object.values(toolsDict)) {
        const decl = (tool as AnyTool)._getDeclaration?.() as Record<string, unknown> | undefined;
        if (!decl) continue;
        result.push({
            type: 'function',
            function: {
                name:        String(decl['name'] ?? ''),
                description: String(decl['description'] ?? ''),
                parameters:  normaliseSchema(decl['parameters']) as OpenAI.FunctionParameters,
            },
        });
    }
    return result;
}

// ── Content converter: GenAI Content[] → OpenAI messages ──────────────────────

type Part = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response?: unknown } };
type Content = { role?: string; parts?: Part[] };

interface PendingCall { tcId: string; name: string }

function genIdFromIndex(n: number): string { return `call_${n.toString().padStart(4, '0')}`; }

function contentsToMessages(
    contents: Content[],
    systemInstruction: string | undefined,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemInstruction) {
        msgs.push({ role: 'system', content: systemInstruction });
    }

    // Assign stable IDs to function calls so responses can be matched
    let idCounter = 0;
    const callStack: PendingCall[] = [];

    for (const content of contents) {
        const parts: Part[] = (content.parts as Part[] | undefined) ?? [];
        const role = content.role ?? 'user';

        // ── model content ───────────────────────────────────────────────────
        if (role === 'model') {
            const fnCallParts = parts.filter((p) => p.functionCall);
            const textParts   = parts.filter((p) => p.text != null);

            if (fnCallParts.length > 0) {
                const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
                for (const p of fnCallParts) {
                    const tcId = genIdFromIndex(idCounter++);
                    callStack.push({ tcId, name: p.functionCall!.name });
                    toolCalls.push({
                        id:   tcId,
                        type: 'function',
                        function: {
                            name:      p.functionCall!.name,
                            arguments: JSON.stringify(p.functionCall!.args ?? {}),
                        },
                    });
                }
                msgs.push({
                    role:       'assistant',
                    content:    textParts.length ? textParts.map((p) => p.text).join('') : null,
                    tool_calls: toolCalls,
                });
                continue;
            }

            // Plain text response
            msgs.push({
                role:    'assistant',
                content: textParts.map((p) => p.text).join('') || '',
            });
            continue;
        }

        // ── user content with function responses ────────────────────────────
        const fnRespParts = parts.filter((p) => p.functionResponse);
        if (fnRespParts.length > 0) {
            for (const p of fnRespParts) {
                // Match by name to the most recent pending call with that name
                const pending = [...callStack].reverse().find((c) => c.name === p.functionResponse!.name);
                const tcId = pending?.tcId ?? genIdFromIndex(idCounter++);
                msgs.push({
                    role:         'tool',
                    tool_call_id: tcId,
                    content:      JSON.stringify(p.functionResponse!.response ?? {}),
                });
            }
            continue;
        }

        // ── plain user message ──────────────────────────────────────────────
        const text = parts.filter((p) => p.text != null).map((p) => p.text).join('');
        msgs.push({ role: 'user', content: text || '(empty)' });
    }

    return msgs;
}

// ── OpenAI response → LlmResponse ─────────────────────────────────────────────

function choiceToLlmResponse(choice: OpenAI.Chat.Completions.ChatCompletion.Choice): LlmResponse {
    const msg = choice.message;

    if ((choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') && msg.tool_calls?.length) {
        const parts = msg.tool_calls.map((tc) => {
            const tcAny = tc as unknown as Record<string, unknown>;
            const fn    = (tcAny['function'] ?? tc) as Record<string, unknown>;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(String(fn['arguments'] ?? '{}')); } catch {}
            return {
                functionCall: {
                    name: String(fn['name'] ?? ''),
                    args,
                },
            };
        });
        return {
            content:      { role: 'model', parts },
            turnComplete: false,
        };
    }

    const text = msg.content ?? '';
    return {
        content:      { role: 'model', parts: [{ text }] },
        turnComplete: true,
    };
}

// ── OpenRouterLlm ─────────────────────────────────────────────────────────────

export class OpenRouterLlm extends BaseLlm {
    /**
     * Register with LLMRegistry so string-based agents also resolve here.
     * Pattern "openrouter/.*" matches any OpenRouter model string.
     */
    static override readonly supportedModels: Array<string | RegExp> = [
        /^openrouter\/.*/,
        /^deepseek\/.*/,
    ];

    /**
     * Accepts either:
     *   new OpenRouterLlm()                     — uses DEFAULT_MODEL from env
     *   new OpenRouterLlm('deepseek/...')        — explicit model string
     *   new OpenRouterLlm({ model: 'gemini-*' }) — called by LLMRegistry.newLlm()
     */
    constructor(modelOrParams?: string | { model: string }) {
        const resolved =
            typeof modelOrParams === 'string'  ? modelOrParams :
            typeof modelOrParams === 'object'  ? modelOrParams.model :
            DEFAULT_MODEL;
        super({ model: resolved });
    }

    async *generateContentAsync(
        req: LlmRequest,
        _stream?: boolean,
    ): AsyncGenerator<LlmResponse, void> {
        const client = getOpenRouterClient();

        // Extract system instruction — can be string or Content object
        const si = req.config?.systemInstruction;
        const systemStr = typeof si === 'string'
            ? si
            : (si && typeof si === 'object' && 'parts' in si)
                ? ((si as unknown as Content).parts ?? []).filter((p) => p.text).map((p) => p.text).join('')
                : undefined;

        const messages = contentsToMessages(req.contents as Content[], systemStr);
        const tools     = toolsToOpenAI(req.toolsDict ?? {});

        console.info(
            `[OpenRouterLlm] →  model=${this.model}  messages=${messages.length}  tools=${tools.length}`,
        );

        let completion: OpenAI.Chat.Completions.ChatCompletion;
        try {
            completion = await client.chat.completions.create({
                model:       this.model,
                messages,
                tools:       tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? 'auto' : undefined,
                temperature: 0.1,
                max_tokens:  8192,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[OpenRouterLlm] API error: ${msg}`);
            yield {
                errorCode:    '500',
                errorMessage: msg,
            };
            return;
        }

        const choice = completion.choices[0];
        if (!choice) {
            yield { errorCode: '500', errorMessage: 'OpenRouter returned no choices.' };
            return;
        }

        const response = choiceToLlmResponse(choice);
        console.info(
            `[OpenRouterLlm] ←  finish_reason=${choice.finish_reason}  ` +
            `parts=${response.content?.parts?.length ?? 0}  ` +
            `preview="${JSON.stringify(response.content?.parts?.[0] ?? '').slice(0, 80)}"`,
        );

        yield response;
    }

    async connect(_req: LlmRequest): Promise<BaseLlmConnection> {
        throw new Error('OpenRouterLlm: live/streaming connections are not supported.');
    }
}

// Auto-register so string-based model resolution also hits OpenRouter
LLMRegistry.register(OpenRouterLlm);
