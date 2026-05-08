/**
 * OpenRouter client — singleton for all agents.
 *
 * Uses the OpenAI-compatible API at https://openrouter.ai/api/v1.
 * All agents share one client instance; model is read from env at call time.
 *
 * Required env vars:
 *   OPENROUTER_API_KEY   sk-or-v1-...
 *
 * Optional env vars:
 *   OPENROUTER_BASE_URL  (default: https://openrouter.ai/api/v1)
 *   OPENROUTER_MODEL     (default: deepseek/deepseek-chat)
 */

import './env.js';
import OpenAI from 'openai';

export const OPENROUTER_BASE_URL =
    (process.env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');

export const DEFAULT_MODEL =
    process.env['OPENROUTER_MODEL'] ?? 'deepseek/deepseek-chat';

let _client: OpenAI | null = null;

export function getOpenRouterClient(): OpenAI {
    if (!_client) {
        const apiKey = process.env['OPENROUTER_API_KEY'];
        if (!apiKey) {
            throw new Error(
                '[OpenRouter] OPENROUTER_API_KEY is not set. ' +
                'Add it to your .env file.',
            );
        }
        _client = new OpenAI({
            baseURL: OPENROUTER_BASE_URL,
            apiKey,
            defaultHeaders: {
                'HTTP-Referer': 'https://medicore.ai',
                'X-Title': 'MediCore AI',
            },
        });
        console.info(`[OpenRouter] Client ready  model=${DEFAULT_MODEL}`);
    }
    return _client;
}
