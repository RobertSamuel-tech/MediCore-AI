/**
 * Care Navigator agent — ADK agent definition.
 *
 * Guides patients through care pathways, coordinates referrals, and manages
 * transitions of care across the MediCore platform.
 *
 * TODO: Add tools for care pathway lookup, referral management, and
 * community resource discovery.
 */

import '../shared/env.js';

import { LlmAgent } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { extractFhirContext } from '../shared/fhirHook.js';

export const rootAgent = new LlmAgent({
    name: 'care_navigator_agent',
    model: new OpenRouterLlm(),
    description:
        'Care Navigator agent — guides patients through care pathways, coordinates referrals, and manages transitions of care.',
    instruction: `You are a care navigation specialist responsible for helping patients and
clinical teams navigate complex care pathways.

Your responsibilities include:
  • Identifying appropriate care pathways based on patient conditions
  • Coordinating referrals to specialist services
  • Managing care transitions between settings (hospital, outpatient, home)
  • Connecting patients with community resources and support services
  • Monitoring care plan adherence and flagging gaps

If FHIR credentials are not available in the current session, tell the caller that
FHIR context must be provided in the request metadata.`,
    beforeModelCallback: extractFhirContext,
});
