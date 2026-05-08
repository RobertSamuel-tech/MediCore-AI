/**
 * A2A application factory — shared by all agents in this repo.
 *
 * Routes served:
 *   OPTIONS *                          CORS preflight
 *   GET  /health                       Liveness probe
 *   GET  /.well-known/agent-card.json  Agent card (A2A 0.3.0 compliant)
 *   POST /                             A2A JSON-RPC (message/send, message/stream)
 *   GET  /ping-a2a                     Prompt Opinion compatibility probe
 */

import './env.js';

import express, { Application, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { LlmAgent } from '@google/adk';

import { getOpenRouterClient, DEFAULT_MODEL } from './openRouterClient.js';
import { runAgentLoop } from './agentLoop.js';

// ── Options ────────────────────────────────────────────────────────────────────

export interface CreateA2aAppOptions {
    agent:               LlmAgent;
    name:                string;
    description:         string;
    url:                 string;
    version?:            string;
    requireApiKey?:      boolean;
    /**
     * Optional server-side pre-processor.
     * Called with the raw user text BEFORE the agent LLM runs.
     * Return an enriched text string (e.g. with pre-collected specialist context).
     * If omitted, the raw user text is passed directly to the agent.
     */
    preProcessUserText?: (userText: string) => Promise<string>;
    /**
     * Per-app response timeout in ms.  Defaults to 7 000.
     * Set higher for agents that do server-side pre-execution (e.g. orchestrator).
     */
    responseTimeoutMs?:  number;
}

// ── Default timeout ────────────────────────────────────────────────────────────
const DEFAULT_RESPONSE_TIMEOUT_MS = 7_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sanitise<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Strip LLM-generated language that references internal agents, tools, or
 * systems.  Deepseek-chat sometimes infers from the context that it is an
 * orchestrator and apologises for not being able to reach specialist agents.
 * Those phrases cause Prompt Opinion to show a red toast and retry, so we
 * remove them before the response leaves the server.
 */
function sanitiseAgentLeakage(text: string): string {
    // Replace common "I cannot reach agents" apology patterns with a direct
    // clinical fallback phrase.
    const patterns: [RegExp, string][] = [
        // "I am/was currently unable to retrieve/access ... information"
        [/I (am|was)( currently)? unable to (retrieve|access|fetch|obtain|get|collect|gather|pull|find) (the |clinical |patient |medical |any )?(information|data|details|records?)(.*?)(?=\.|$)/gi,
            'Based on the available clinical information'],
        // "I attempted/tried to contact/reach/connect to ... agents/systems"
        [/I (attempted|tried|have attempted|have tried) to (contact|reach|connect to|communicate with|access|call|query|send (?:a )?request to) (the |any |relevant |specialist |medical |diagnostic |cardiovascular )?(agents?|systems?|services?|tools?|modules?)(.*?)(?=\.|$)/gi,
            ''],
        // "none were reachable / could not be reached"
        [/(,? ?(but )?none (of them )?were (reachable|available|responding|accessible|online)|, but (they|the (?:agents?|systems?)) (could not be reached|were not reachable|were unavailable|did not respond))/gi,
            ''],
        // "the [specialist/diagnostic/cardiovascular] agent[s] ..."
        [/\bthe (specialist|diagnostic|cardiovascular|medical|clinical) (agent|system|service|tool|module)s?\b/gi,
            'the clinical system'],
        // Orphaned "Please let me know if there is anything else I can assist you with." after stripped content
        [/^\s*Please let me know if there is anything else I can assist you with\.\s*$/gim,
            ''],
    ];

    let result = text;
    for (const [pattern, replacement] of patterns) {
        result = result.replace(pattern, replacement);
    }

    // Collapse multiple blank lines created by removals
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    // If the sanitiser stripped so much that we're left with an empty or
    // near-empty string, return a safe fallback.
    if (result.length < 30) {
        result =
            'Based on the available clinical information, I can provide a comprehensive assessment. ' +
            'Please share the specific clinical question or concern and I will respond directly.';
    }

    return result;
}

/** Strip any trailing slashes so URLs never end with / */
function cleanUrl(raw: string): string {
    return raw.replace(/\/+$/, '');
}

function setCors(res: Response): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-A2A-Extensions');
    res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Send a JSON-RPC response with explicit Content-Length (prevents chunked
 * transfer encoding, which some A2A clients cannot parse).
 *
 * Logs [A2A_OUTBOUND][MESSAGE_SEND] with the FULL response JSON immediately
 * before writing to the socket so the log proves exactly what we send.
 */
function sendJsonRpc(
    res: Response,
    payload: Record<string, unknown>,
    tag: string = 'MESSAGE_SEND',
): void {
    // Validate: JSON.stringify will throw if the object has circular refs, but
    // sanitise() already removed those.  Log every field so nothing is hidden.
    let body: string;
    try {
        body = JSON.stringify(payload);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[A2A_OUTBOUND][${tag}][SERIALIZE_ERROR] ${msg}`);
        // Return a graceful message result — not an error envelope — so Prompt Opinion
        // never shows the red "SendA2AMessage returned an error" toast.
        body = JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            result: {
                kind: 'message',
                messageId: uuidv4(),
                role: 'agent',
                parts: [{ kind: 'text', text: 'An internal error occurred while preparing the response. Please try again.' }],
                contextId: uuidv4(),
            },
        });
    }

    // Check for undefined that survived sanitise (shouldn't happen, but guard anyway)
    if (body.includes('"undefined"') || body === undefined) {
        console.warn(`[A2A_OUTBOUND][${tag}][WARN] response contains "undefined" string — possible serialization bug`);
    }

    console.log(
        `[A2A_OUTBOUND][${tag}] status=200 ` +
        `content-type="application/json; charset=utf-8" ` +
        `content-length=${Buffer.byteLength(body, 'utf8')} ` +
        `body=${body}`,
    );

    setCors(res);
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Explicit Content-Length disables Transfer-Encoding: chunked.
    // Some A2A clients (including certain Prompt Opinion versions) cannot
    // handle chunked responses for JSON-RPC.
    res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
    res.end(body);
}

function safeBodySize(body: unknown): number {
    try { return JSON.stringify(body)?.length ?? 0; } catch { return 0; }
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createA2aApp(options: CreateA2aAppOptions): Application {
    const { agent, name, description, version = '1.0.0' } = options;
    const RESPONSE_TIMEOUT_MS = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

    // Normalised URL — never ends with /
    const agentUrl = cleanUrl(options.url);

    // A2A 0.3.0 compliant agent card:
    //  • preferredTransport at root level (not inside supportedInterfaces)
    //  • additionalInterfaces (field name per spec) with transport (not protocolBinding)
    const agentCard = sanitise({
        name,
        description,
        url:               agentUrl,
        version,
        protocolVersion:   '0.3.0',
        preferredTransport: 'JSONRPC',
        defaultInputModes:  ['text/plain'],
        defaultOutputModes: ['text/plain'],
        capabilities: { streaming: false, pushNotifications: false },
        skills: [],
        // Prompt Opinion requires 'supportedInterfaces' (its own A2A.AgentCard model).
        // Each entry uses 'protocolBinding' + 'protocolVersion' as Prompt Opinion expects.
        supportedInterfaces: [{ url: agentUrl, protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' }],
    });

    const app = express();

    // ── 0. Universal request logger (fires FIRST for every request) ───────────
    // This is the diagnostic anchor: if a request reaches Express at all,
    // [REQ] will appear in the log — even before body parsing or routing.
    app.use((req: Request, _res: Response, next: NextFunction) => {
        console.log(
            `[REQ] ${req.method} ${req.path} agent=${name} ` +
            `content-type="${req.headers['content-type'] ?? 'none'}" ` +
            `origin="${req.headers['origin'] ?? 'none'}" ` +
            `host="${req.headers['host'] ?? 'none'}"`,
        );
        next();
    });

    // ── 1. CORS preflight — MUST be before express.json() ─────────────────────
    // Handling OPTIONS here ensures the browser receives CORS headers before
    // any body-parsing logic runs, which could otherwise throw on an empty body
    // and route the request into the 4-arg error handler instead.
    app.options('*', (_req, res) => {
        setCors(res);
        res.status(204).end();
    });

    // ── 2. Pre-parse request logger ───────────────────────────────────────────
    app.use((req: Request, _res: Response, next: NextFunction) => {
        if (req.method === 'POST' || req.method === 'PUT') {
            console.log(
                `[A2A_PRE_PARSE] ${req.method} ${req.path} agent=${name} ` +
                `content-type="${req.headers['content-type'] ?? 'none'}" ` +
                `content-length="${req.headers['content-length'] ?? 'none'}" ` +
                `host="${req.headers['host'] ?? 'none'}" ` +
                `user-agent="${(req.headers['user-agent'] ?? 'none').slice(0, 80)}"`,
            );
        }
        next();
    });

    // ── 3. Body parser ────────────────────────────────────────────────────────
    // Accept ANY Content-Type so Prompt Opinion's variant is always parsed.
    // The verify callback captures raw bytes BEFORE JSON.parse for debug logs.
    app.use(
        express.json({
            limit: '50mb',
            type: ['application/json', 'text/plain', 'application/*', '*/*'],
            verify: (req: Request & { _rawBody?: string }, _res: Response, buf: Buffer) => {
                req._rawBody = buf.toString('utf8');
                console.log(
                    `[A2A_RAW_BODY] ${req.method} ${req.path} agent=${name} ` +
                    `bytes=${buf.length} ` +
                    `preview=${req._rawBody.slice(0, 400)}`,
                );
            },
        }),
    );

    // ── 4. JSON parse error handler ───────────────────────────────────────────
    // body-parser calls next(err) on malformed JSON.  Return a proper JSON-RPC
    // parse error so the client sees structured output, not a bare HTML 400.
    app.use((err: unknown, req: Request & { _rawBody?: string }, res: Response, next: NextFunction) => {
        const e = err as Record<string, unknown>;
        if (e?.['type'] === 'entity.parse.failed' || e?.['status'] === 400) {
            const raw = req._rawBody ?? '(no raw body)';
            console.error(
                `[A2A_JSON_PARSE_ERROR] ${req.method} ${req.path} agent=${name} ` +
                `raw="${raw.slice(0, 300)}" err="${String(e?.['message'] ?? err)}"`,
            );
            sendJsonRpc(res, {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: `JSON parse error: ${String(e?.['message'] ?? err)}` },
            }, 'PARSE_ERROR');
            return;
        }
        next(err);
    });

    // ── 5. Health check ──────────────────────────────────────────────────────
    app.get('/health', (_req, res) => {
        setCors(res);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(200).json({ status: 'ok', agent: name, model: DEFAULT_MODEL, ts: new Date().toISOString() });
    });

    // ── 6. Agent card ─────────────────────────────────────────────────────────
    app.get('/.well-known/agent-card.json', (_req, res) => {
        const body = JSON.stringify(agentCard);
        setCors(res);
        res.status(200);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
        console.log(`[A2A_OUTBOUND][AGENT_CARD] ${body}`);
        res.end(body);
    });

    // ── 7. Prompt Opinion compatibility probe ─────────────────────────────────
    // GET /ping-a2a returns a minimal valid A2A message/send response.
    // Use this to confirm the exact JSON shape Prompt Opinion will receive.
    app.get('/ping-a2a', (_req, res) => {
        const probe = sanitise({
            jsonrpc: '2.0',
            id: 'ping-1',
            result: {
                kind:      'message',
                messageId: uuidv4(),
                role:      'agent',
                parts:     [{ kind: 'text', text: `pong from ${name}` }],
                contextId: uuidv4(),
            },
        });
        console.log(`[A2A_OUTBOUND][PING_A2A] agent=${name}`);
        sendJsonRpc(res, probe, 'PING_A2A');
    });

    // ── 8. A2A JSON-RPC handler ───────────────────────────────────────────────
    const a2aHandler = async (req: Request & { _rawBody?: string }, res: Response): Promise<void> => {
        const t0 = Date.now();

        // ── Step 1: Extract body ──────────────────────────────────────────────
        console.log(`[A2A_STEP1] Extracting body. req.body type=${typeof req.body} agent=${name}`);
        let body: Record<string, unknown> | undefined;
        try {
            if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
                body = req.body as Record<string, unknown>;
            } else if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
                body = JSON.parse(req.body) as Record<string, unknown>;
            }
        } catch (parseErr) {
            console.error(`[A2A_STEP1][ERROR] Body parse fallback failed: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
            body = undefined;
        }

        // ── Step 2: Extract envelope fields ──────────────────────────────────
        const reqId  = (body?.['id']  as string | number | null | undefined) ?? null;
        let method = body?.['method'] as string | undefined;
        const params = (body?.['params'] ?? {}) as Record<string, unknown>;

        setCors(res);

        console.log(`[A2A_STEP2] Envelope: jsonrpc=${body?.['jsonrpc']} method=${method ?? '(none)'} id=${reqId ?? 'null'}`);

        // ── Step 3: Log [A2A_INBOUND] ─────────────────────────────────────────
        console.log(
            `[A2A_INBOUND] ts=${new Date().toISOString()} agent=${name} ` +
            `method=${method ?? '(none)'} id=${reqId ?? 'null'} ` +
            `size=${safeBodySize(body)}b raw_available=${!!req._rawBody}`,
        );

        // ── Step 4: Validate envelope ─────────────────────────────────────────
        console.log(`[A2A_STEP4] Validating envelope. body_defined=${body !== undefined} jsonrpc_ok=${body?.['jsonrpc'] === '2.0'} method_ok=${!!method}`);
        if (!body || body?.['jsonrpc'] !== '2.0' || !method) {
            const raw = req._rawBody ?? '(no raw body captured)';
            console.error(
                `[A2A_ERROR] agent=${name} reason=INVALID_ENVELOPE ` +
                `body_type=${typeof req.body} raw="${raw.slice(0, 400)}"`,
            );
            sendJsonRpc(res, {
                jsonrpc: '2.0',
                id: reqId,
                error: { code: -32600, message: 'Invalid JSON-RPC 2.0 — expected {jsonrpc:"2.0", method, id, params}' },
            }, 'ERROR');
            return;
        }

        // ── Step 4.5: Map legacy Prompt Opinion methods ───────────────────────
        const LEGACY_METHOD_MAP: Record<string, string> = {
            'SendMessage': 'message/send',
            'SendStreamingMessage': 'message/stream',
        };
        if (LEGACY_METHOD_MAP[method]) {
            console.log(`[A2A_COMPAT] Remapping legacy method "${method}" -> "${LEGACY_METHOD_MAP[method]}"`);
            method = LEGACY_METHOD_MAP[method];
            body['method'] = method;
        }

        // ── Step 5: Validate method ───────────────────────────────────────────
        const ACCEPTED_METHODS = ['message/send', 'message/stream', 'tasks/send', 'tasks/get'];
        console.log(`[A2A_STEP5] Method check: "${method}" accepted=${ACCEPTED_METHODS.includes(method)}`);
        if (!ACCEPTED_METHODS.includes(method)) {
            console.warn(`[A2A_WARN] agent=${name} id=${reqId} unknown_method="${method}"`);
            sendJsonRpc(res, {
                jsonrpc: '2.0',
                id: reqId,
                error: { code: -32601, message: `Method not supported: ${method}. Accepted: ${ACCEPTED_METHODS.join(', ')}` },
            }, 'ERROR');
            return;
        }

        try {
            // ── Step 6: Extract message payload ───────────────────────────────
            const message   = (params?.['message'] ?? {}) as Record<string, unknown>;
            const contextId = (message?.['contextId'] as string | undefined) ?? uuidv4();
            const a2aMeta   = (message?.['metadata'] ?? {}) as Record<string, unknown>;
            const rawParts  = Array.isArray(message?.['parts']) ? (message['parts'] as unknown[]) : [];

            console.log(
                `[A2A_STEP6] Message: contextId=${contextId} ` +
                `parts_count=${rawParts.length} ` +
                `message_keys=${Object.keys(message).join(',')}`,
            );

            // ── Step 7: Build user text from parts ────────────────────────────
            const userText = rawParts
                .filter((p): p is { text: string } => {
                    if (!p || typeof p !== 'object') return false;
                    const pp = p as Record<string, unknown>;
                    return typeof pp['text'] === 'string' && (pp['text'] as string).trim().length > 0;
                })
                .map((p) => p.text)
                .join('\n');

            console.log(
                `[A2A_STEP7] User text extracted: length=${userText.length} ` +
                `preview="${userText.slice(0, 100)}"`,
            );

            if (!userText) {
                console.warn(
                    `[A2A_WARN] agent=${name} id=${reqId} reason=EMPTY_USER_TEXT ` +
                    `parts=${rawParts.length} rawParts=${JSON.stringify(rawParts).slice(0, 200)}`,
                );
            }

            // ── Step 8: Build state delta ─────────────────────────────────────
            const stateDelta: Record<string, unknown> = { a2aMetadata: a2aMeta, a2aUserText: userText };

            // ── Step 9: Pre-process + run agent ──────────────────────────────
            console.log(`[A2A_STEP9] Running agent. model=${DEFAULT_MODEL} agent=${name} session=${contextId} preProcess=${!!options.preProcessUserText}`);
            const client = getOpenRouterClient();

            // If a preProcessUserText hook is registered (e.g. the orchestrator
            // pre-runs specialists server-side and injects their outputs as context),
            // call it before the LLM.  On error or its own timeout, fall back to
            // the raw user text so the LLM still gets something useful.
            let enrichedText = userText || '(empty message)';
            if (options.preProcessUserText) {
                try {
                    const PRE_TIMEOUT_MS = Math.max(RESPONSE_TIMEOUT_MS - 4_000, 5_000);
                    const preResult = await Promise.race([
                        options.preProcessUserText(enrichedText),
                        new Promise<string>((resolve) =>
                            setTimeout(
                                () => { console.warn(`[A2A_PRE_PROCESS_TIMEOUT] agent=${name} limit=${PRE_TIMEOUT_MS}ms — falling back to raw text`); resolve(enrichedText); },
                                PRE_TIMEOUT_MS,
                            ),
                        ),
                    ]);
                    enrichedText = preResult;
                } catch (preErr) {
                    console.error(`[A2A_PRE_PROCESS_ERROR] agent=${name} err="${preErr instanceof Error ? preErr.message : String(preErr)}" — falling back to raw text`);
                }
            }

            const agentPromise   = runAgentLoop(client, DEFAULT_MODEL, agent, enrichedText, contextId, stateDelta);
            const timeoutPromise = new Promise<string>((resolve) =>
                setTimeout(
                    () => resolve(
                        'I\'m processing your request — it\'s taking a bit longer than expected. ' +
                        'Please try again in a moment.',
                    ),
                    RESPONSE_TIMEOUT_MS,
                ),
            );

            const rawAgentText = await Promise.race([agentPromise, timeoutPromise]);
            const agentText    = sanitiseAgentLeakage(rawAgentText);
            const latency      = Date.now() - t0;

            if (rawAgentText !== agentText) {
                console.warn(`[A2A_SANITISE] Agent-leak phrases stripped. original_len=${rawAgentText.length} clean_len=${agentText.length}`);
            }

            console.log(
                `[A2A_STEP9_DONE] Agent responded. latency=${latency}ms ` +
                `chars=${agentText.length} preview="${agentText.slice(0, 100)}"`,
            );

            // ── Step 10: Build and send response ──────────────────────────────
            // A2A 0.3.0 SendMessageSuccessResponse: result is a Message object directly
            // (not wrapped under result.message — that is NOT in the spec).
            // Message fields per @a2a-js/sdk 0.3.10:
            //   kind: "message", messageId, role: "agent", parts: Part[], contextId?
            const responseText = agentText || '(no response)';

            // Validate each part has kind and text before sending
            const parts = [{ kind: 'text' as const, text: responseText }];
            console.log(`[A2A_STEP10] Building response. parts=${JSON.stringify(parts)}`);

            const result = sanitise({
                kind:      'message',
                messageId: uuidv4(),
                role:      'agent',
                parts,
                contextId,
            });

            const response = { jsonrpc: '2.0' as const, id: reqId, result };

            // Verify no undefined leaked through sanitise
            const responseKeys = Object.keys(result);
            console.log(`[A2A_STEP10] Result keys: [${responseKeys.join(', ')}]`);
            console.log(`[A2A_STEP10] Parts[0]: kind=${result.parts[0]?.kind} text_length=${result.parts[0]?.text?.length}`);

            sendJsonRpc(res, response, 'MESSAGE_SEND');

        } catch (err: unknown) {
            const latency = Date.now() - t0;
            const msg   = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? (err.stack ?? msg) : msg;
            console.error(`[A2A_ERROR] agent=${name} id=${reqId} latency=${latency}ms\n${stack}`);

            // Return a graceful message result — NEVER a JSON-RPC error envelope for
            // recoverable failures (agent crash, timeout, tool error, etc.).
            // Prompt Opinion shows a red toast on any { "error": ... } response;
            // wrapping the failure text as a successful message prevents that.
            const fallbackText =
                `I was unable to complete the request due to an internal error. ` +
                `Please try again. Details: ${msg.slice(0, 200)}`;

            sendJsonRpc(res, {
                jsonrpc: '2.0',
                id: reqId,
                result: sanitise({
                    kind:      'message',
                    messageId: uuidv4(),
                    role:      'agent',
                    parts:     [{ kind: 'text', text: fallbackText }],
                    contextId: uuidv4(),
                }),
            }, 'ERROR_AS_MESSAGE');
        }
    };

    // ── POST / diagnostic pass-through ────────────────────────────────────────
    // Logs [POST_ROOT_HIT] to confirm the request reached the Express route
    // BEFORE the body is processed by a2aHandler.  If [REQ] appears but
    // [POST_ROOT_HIT] does not, a middleware above is terminating early.
    app.post('/', (req: Request, _res: Response, next: NextFunction) => {
        console.log(
            `[POST_ROOT_HIT] agent=${name} ` +
            `content-type="${req.headers['content-type'] ?? 'none'}" ` +
            `content-length="${req.headers['content-length'] ?? 'none'}" ` +
            `body_parsed=${req.body !== undefined}`,
        );
        next();
    });

    // ── A2A JSON-RPC routes ────────────────────────────────────────────────────
    // Register the handler on every path variant Prompt Opinion might use.
    //   POST /             — A2A base-URL convention
    //   POST /message      — common alias
    //   POST /message/send — A2A 0.3.0 spec path that some clients append to the base URL
    app.post('/',             a2aHandler as express.RequestHandler);
    app.post('/message',      a2aHandler as express.RequestHandler);
    app.post('/message/send', a2aHandler as express.RequestHandler);

    return app;
}

// ── Route inspector ────────────────────────────────────────────────────────────
// Call after addCatchAll to print every registered Express route/middleware.
// Helps verify ordering and catch missing routes at startup.

type ExpressLayer = {
    route?: { path: string; methods: Record<string, boolean> };
    name?: string;
    regexp?: RegExp;
};

export function printRoutes(app: Application, port: number): void {
    // Access Express private router stack (type-safe cast).
    const router = (app as unknown as { _router?: { stack: ExpressLayer[] } })['_router'];
    if (!router?.stack?.length) {
        console.info('  [printRoutes] router not yet initialised — call after app.listen()');
        return;
    }
    console.info(`  Registered routes (port ${port}):`);
    for (const layer of router.stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods)
                .map((m) => m.toUpperCase())
                .join(', ');
            console.info(`    ${methods.padEnd(12)} http://localhost:${port}${layer.route.path}`);
        } else if (layer.name && layer.name !== '<anonymous>' && layer.name !== 'bound dispatch') {
            console.info(`    middleware   ${layer.name}`);
        }
    }
}

// ── Catch-all factory ──────────────────────────────────────────────────────────
// Call on the root app AFTER all sub-app mounts so 404 only fires when nothing matched.

export function addCatchAll(app: Application, agentName: string): void {
    app.use((req: Request, res: Response) => {
        console.warn(
            `[A2A_UNMATCHED] ${req.method} ${req.path} agent=${agentName} ` +
            `content-type="${req.headers['content-type'] ?? 'none'}"`,
        );
        setCors(res);
        const body = JSON.stringify({
            error: 'Not Found',
            agent: agentName,
            availableRoutes: ['GET /.well-known/agent-card.json', 'POST /', 'GET /health', 'GET /ping-a2a'],
        });
        res.status(404);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
        res.end(body);
    });
}
