/**
 * Environment setup — imported by every agent and appFactory.
 *
 * Loads .env via dotenv so OPENROUTER_API_KEY, MEDPLUM_*, and other
 * variables are available before any SDK code runs.
 *
 * Google Gemini / GOOGLE_API_KEY have been removed.
 * All LLM calls now route through OpenRouter (shared/openRouterClient.ts).
 */

import 'dotenv/config';
