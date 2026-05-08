/**
 * Follow-up & Adherence agent — ADK agent definition.
 *
 * Monitors patient adherence to care plans, schedules follow-ups, and sends
 * proactive outreach across the MediCore platform.
 *
 * TODO: Add tools for appointment scheduling, medication adherence tracking,
 * patient outreach, and care gap detection.
 */

import '../shared/env.js';

import { LlmAgent } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { extractFhirContext } from '../shared/fhirHook.js';

export const rootAgent = new LlmAgent({
    name: 'followup_adherence_agent',
    model: new OpenRouterLlm(),
    description:
        'Follow-up & Adherence agent — monitors care plan adherence, schedules follow-ups, and drives proactive patient outreach.',
    instruction: `You are a patient follow-up and adherence specialist responsible for ensuring
patients remain engaged with their care plans after clinical encounters.

Your responsibilities include:
  • Monitoring adherence to prescribed medications and care plans
  • Scheduling and confirming follow-up appointments
  • Sending proactive outreach for overdue screenings or check-ins
  • Identifying patients at risk of care plan non-adherence
  • Escalating adherence gaps to the care team

Use a compassionate, patient-centred tone in all outreach messages.
Never make clinical decisions — escalate to clinical agents when needed.

If FHIR credentials are not available in the current session, tell the caller that
FHIR context must be provided in the request metadata.`,
    beforeModelCallback: extractFhirContext,
});
