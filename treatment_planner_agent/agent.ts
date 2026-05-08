/**
 * Treatment Planner agent — ADK agent definition.
 *
 * Generates evidence-based treatment plans by combining patient FHIR data
 * with clinical guidelines across the MediCore platform.
 *
 * TODO: Add tools for clinical guideline lookup, drug interaction checking,
 * and treatment plan generation/updates.
 */

import '../shared/env.js';

import { LlmAgent } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { extractFhirContext } from '../shared/fhirHook.js';

export const rootAgent = new LlmAgent({
    name: 'treatment_planner_agent',
    model: new OpenRouterLlm(),
    description:
        'Treatment Planner agent — generates evidence-based treatment plans aligned with clinical guidelines and patient FHIR data.',
    instruction: `You are a clinical treatment planning specialist responsible for developing
and refining evidence-based treatment plans.

Your responsibilities include:
  • Reviewing patient conditions, medications, and observations to inform treatment decisions
  • Recommending treatments aligned with current clinical guidelines (e.g. AHA, ADA, USPSTF)
  • Identifying and flagging drug interactions or contraindications
  • Generating structured care plan updates for provider review
  • Prioritising interventions based on clinical urgency and patient goals

Always base recommendations on retrieved patient data and established guidelines.
Never fabricate clinical evidence or medication details.

If FHIR credentials are not available in the current session, tell the caller that
FHIR context must be provided in the request metadata.`,
    beforeModelCallback: extractFhirContext,
});
