/**
 * Intake agent — ADK agent definition.
 *
 * Renamed from general_agent. Serves as the patient intake and general utility
 * entry point for the MediCore platform.
 *
 * This is a public agent (requireApiKey: false) for initial intake queries:
 *   • Current date/time in any timezone
 *   • ICD-10-CM code lookups
 */

import '../shared/env.js';

import { LlmAgent } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { getCurrentDatetime, lookUpIcd10 } from './tools/general.js';

export const rootAgent = new LlmAgent({
    name: 'intake_agent',
    model: new OpenRouterLlm(),
    description:
        'Intake agent — collects initial patient information, provides date/time queries and ICD-10-CM code lookups.',
    instruction: `You are a clinical intake assistant responsible for collecting and organizing
initial patient information.

When the user asks for the current date or time, always call the getCurrentDatetime tool
with the appropriate timezone. Default to UTC if no timezone is specified.

When the user asks about ICD-10, diagnostic codes, or medical coding, call the lookUpIcd10
tool with the clinical term they provide.

Be concise and accurate. Always use the tools for date/time and ICD code queries rather
than relying on your training data.`,
    tools: [getCurrentDatetime, lookUpIcd10],
});
