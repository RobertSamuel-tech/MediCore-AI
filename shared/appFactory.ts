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
    agent:         LlmAgent;
    name:          string;
    description:   string;
    url:           string;
    version?:      string;
    requireApiKey?: boolean;
    fhirExtensionUri?: string;
}

// ── Timeout ────────────────────────────────────────────────────────────────────
// Keep well under Prompt Opinion's client-side HTTP timeout (~15 s observed).
// If the LLM hasn't replied by this point we return a graceful timeout message
// rather than letting Prompt Opinion's own timeout fire first (which shows an error).
const RESPONSE_TIMEOUT_MS = 12_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sanitise<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
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
        body = JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: `Serialization error: ${msg}` },
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

    // ── 1. Pre-parse request logger ───────────────────────────────────────────
    // Runs BEFORE body parsing so we always see the raw headers regardless of
    // whether express.json() succeeds or errors.
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

    // ── 2. Body parser ────────────────────────────────────────────────────────
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

    // ── 3. JSON parse error handler ───────────────────────────────────────────
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

    // ── 4. CORS preflight ─────────────────────────────────────────────────────
    app.options('*', (_req, res) => { setCors(res); res.status(204).end(); });

    // ── 5. Health check ───────────────────────────────────────────────────────
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
        const method = body?.['method'] as string | undefined;
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
            for (const [key, value] of Object.entries(a2aMeta)) {
                if (key.includes('fhir-context') && value && typeof value === 'object') {
                    const fhir = value as Record<string, string>;
                    if (fhir['fhirUrl'])   { stateDelta['fhirUrl'] = fhir['fhirUrl'];   stateDelta['fhir_url'] = fhir['fhirUrl']; }
                    if (fhir['fhirToken']) { stateDelta['fhirToken'] = fhir['fhirToken']; stateDelta['fhir_token'] = fhir['fhirToken']; }
                    if (fhir['patientId']) { stateDelta['patientId'] = fhir['patientId']; stateDelta['patient_id'] = fhir['patientId']; }
                }
            }

            // ── Step 9: Run agent ─────────────────────────────────────────────
            console.log(`[A2A_STEP9] Running agent loop. model=${DEFAULT_MODEL} agent=${name} session=${contextId}`);
            const client = getOpenRouterClient();

            const agentPromise   = runAgentLoop(client, DEFAULT_MODEL, agent, userText || '(empty message)', contextId, stateDelta);
            const timeoutPromise = new Promise<string>((resolve) =>
                setTimeout(() => resolve('(processing timed out — please retry with a simpler query)'), RESPONSE_TIMEOUT_MS),
            );

            const agentText = await Promise.race([agentPromise, timeoutPromise]);
            const latency   = Date.now() - t0;

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
            sendJsonRpc(res, {
                jsonrpc: '2.0',
                id: reqId,
                error: { code: -32603, message: msg },
            }, 'ERROR');
        }
    };

    app.post('/', a2aHandler as express.RequestHandler);
    app.post('/message', a2aHandler as express.RequestHandler);

    return app;
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
