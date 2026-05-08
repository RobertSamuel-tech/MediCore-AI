/**
 * MediCore Orchestrator — enterprise multi-agent healthcare coordination engine.
 *
 * LLM backend: OpenRouter (deepseek/deepseek-chat by default) via shared/agentLoop.ts
 *
 * Orchestration sequence:
 *   1.  Emergency triage
 *   2.  health_memory_agent      → Medplum FHIR longitudinal context
 *   3.  diagnosis_agent          → clinical analysis
 *   4.  intake_agent             → ICD-10-CM codes
 *   5.  care_navigator_agent     → care pathways + referrals
 *   6.  social_barrier_agent     → SDOH screening
 *   7.  treatment_planner_agent  → evidence-based treatment plan
 *   8.  insurance_billing_agent  → cost, coverage, prior auth
 *   9.  followup_adherence_agent → follow-up schedule
 *   10. assembleMediCoreReport   → validate + emit final JSON
 */

import '../shared/env.js';

import { LlmAgent, FunctionTool } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { z } from 'zod/v3';
import { v4 as uuidv4 } from 'uuid';

import { getOpenRouterClient, DEFAULT_MODEL } from '../shared/openRouterClient.js';
import { runAgentLoop } from '../shared/agentLoop.js';

// ── Logging infrastructure ─────────────────────────────────────────────────────
//
// Three helpers cover the full lifecycle of every specialist agent call:
//   logAgentCall()     → [AGENT_CALL]     fires before the tool executes
//   logAgentResponse() → [AGENT_RESPONSE] fires after the tool returns
//   logAgentError()    → [AGENT_ERROR]    fires when an exception is thrown
//
// Per-call latency is tracked in _timings. Key format: "agentName:epoch:nonce"
// — the nonce prevents collisions when the same agent is called twice in one session.

const _timings = new Map<string, number>();

function logAgentCall(agentName: string, args: Record<string, unknown>): string {
    const callId = `${agentName}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    _timings.set(callId, Date.now());

    // Best-effort payload preview — args may be a raw string or structured object.
    const rawPayload = typeof args['request'] === 'string'
        ? args['request']
        : JSON.stringify(args);
    const payloadPreview = rawPayload.slice(0, 150) + (rawPayload.length > 150 ? '…' : '');

    console.log(
        `[ORCHESTRATOR][AGENT_CALL] agent=${agentName} ` +
        `endpoint=local://${agentName} callId=${callId}`,
    );
    console.log(
        `[ORCHESTRATOR][AGENT_CALL] payload=${JSON.stringify({ agent: agentName, preview: payloadPreview })}`,
    );

    return callId;
}

function logAgentResponse(callId: string, agentName: string, response: unknown): void {
    const start = _timings.get(callId) ?? Date.now();
    const latencyMs = Date.now() - start;
    _timings.delete(callId);

    const body = typeof response === 'string' ? response : JSON.stringify(response ?? '');
    const bodyPreview = body.slice(0, 200) + (body.length > 200 ? '…' : '');

    const isFailure =
        typeof response === 'object' &&
        response !== null &&
        (
            'error' in response ||
            ((response as Record<string, unknown>)['status'] === 'error')
        );

    if (isFailure) {
        console.error(
            `[ORCHESTRATOR][AGENT_RESPONSE] agent=${agentName} callId=${callId} ` +
            `status=failure latency=${latencyMs}ms body="${bodyPreview}"`,
        );
    } else {
        console.log(
            `[ORCHESTRATOR][AGENT_RESPONSE] agent=${agentName} callId=${callId} ` +
            `status=success latency=${latencyMs}ms bodyLength=${body.length} body="${bodyPreview}"`,
        );
    }
}

function logAgentError(agentName: string, error: unknown, callId?: string): void {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? 'none') : 'none';
    const lower = msg.toLowerCase();

    let errorType = 'UNKNOWN_ERROR';
    if (lower.includes('timeout') || lower.includes('timed out'))
        errorType = 'TIMEOUT';
    else if (lower.includes('fetch') || lower.includes('econnrefused') ||
             lower.includes('network') || lower.includes('socket'))
        errorType = 'FETCH_FAILURE';
    else if (lower.includes('json') || lower.includes('parse') ||
             lower.includes('syntax') || lower.includes('unexpected token'))
        errorType = 'INVALID_JSON';
    else if (lower.includes('401') || lower.includes('403') ||
             lower.includes('unauthorized') || lower.includes('api key') ||
             lower.includes('forbidden'))
        errorType = 'AUTH_FAILURE';

    if (callId) {
        const start = _timings.get(callId);
        const latencyMs = start ? `${Date.now() - start}ms` : 'unknown';
        _timings.delete(callId);
        console.error(
            `[ORCHESTRATOR][AGENT_ERROR] agent=${agentName} type=${errorType} ` +
            `callId=${callId} latency=${latencyMs} error="${msg}"`,
        );
    } else {
        console.error(
            `[ORCHESTRATOR][AGENT_ERROR] agent=${agentName} type=${errorType} error="${msg}"`,
        );
    }
    console.error(`[ORCHESTRATOR][AGENT_ERROR] stack=${stack}`);
}

import { rootAgent as intakeAgent }            from '../intake_agent/agent.js';
import { rootAgent as diagnosisAgent }         from '../diagnosis_agent/agent.js';
import { rootAgent as careNavigatorAgent }     from '../care_navigator_agent/agent.js';
import { rootAgent as treatmentPlannerAgent }  from '../treatment_planner_agent/agent.js';
import { rootAgent as insuranceBillingAgent }  from '../insurance_billing_agent/agent.js';
import { rootAgent as followupAdherenceAgent } from '../followup_adherence_agent/agent.js';
import { rootAgent as healthMemoryAgent }      from '../health_memory_agent/agent.js';
import { rootAgent as socialBarrierAgent }     from '../social_barrier_agent/agent.js';

// ── OpenRouter specialist agent tool factory ──────────────────────────────────
//
// Creates a FunctionTool that runs a sub-agent via OpenRouter (agentLoop.ts).
// Replaces the previous ADK-runner-based createTimedAgentTool.
//
// Each tool call:
//   1. Calls runAgentLoop with the sub-agent's instruction + tools
//   2. Returns { status:'success', response } or { status:'error', fallback }
//   3. Logs latency and response preview

const AGENT_TIMEOUT_MS = 30_000;  // 30 s — generous for Medplum + LLM round-trip

function createOpenRouterAgentTool(agent: LlmAgent): FunctionTool {
    return new FunctionTool({
        name:        agent.name,
        description: agent.description ?? `Specialist agent: ${agent.name}`,
        parameters:  z.object({
            request: z
                .string()
                .describe(
                    `Full query for ${agent.name}. ` +
                    'Include all relevant patient context from previous agent responses.',
                ),
        }),
        execute: async (input: { request: string }) => {
            const callId    = `${agent.name}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
            const startTime = Date.now();
            const sessionId = uuidv4();

            console.log(
                `[ORCHESTRATOR][AGENT_CALL_START] agent=${agent.name} callId=${callId} ` +
                `request="${input.request.slice(0, 150)}${input.request.length > 150 ? '…' : ''}"`,
            );

            const client = getOpenRouterClient();
            const runPromise = runAgentLoop(client, DEFAULT_MODEL, agent, input.request, sessionId);

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`TIMEOUT: ${agent.name} did not respond within ${AGENT_TIMEOUT_MS}ms`)),
                    AGENT_TIMEOUT_MS,
                ),
            );

            try {
                const responseText = await Promise.race([runPromise, timeoutPromise]);
                const latencyMs    = Date.now() - startTime;

                if (!responseText.trim()) {
                    console.error(`[ORCHESTRATOR][AGENT_CALL_FAILURE] agent=${agent.name} callId=${callId} type=EMPTY_RESPONSE latency=${latencyMs}ms`);
                    return { status: 'error', agent: agent.name, reason: 'Agent returned empty response', fallback: `${agent.name} returned no output — manual review required.` };
                }

                const preview = responseText.slice(0, 200) + (responseText.length > 200 ? '…' : '');
                console.log(`[ORCHESTRATOR][AGENT_CALL_SUCCESS] agent=${agent.name} callId=${callId} latency=${latencyMs}ms responseLength=${responseText.length} response="${preview}"`);

                return { status: 'success', agent: agent.name, response: responseText };

            } catch (err: unknown) {
                const latencyMs = Date.now() - startTime;
                const msg       = err instanceof Error ? err.message : String(err);
                const isTimeout = msg.startsWith('TIMEOUT:');
                console.error(`[ORCHESTRATOR][AGENT_CALL_FAILURE] agent=${agent.name} callId=${callId} type=${isTimeout ? 'TIMEOUT' : 'ERROR'} latency=${latencyMs}ms reason="${msg}"`);
                logAgentError(agent.name, err, callId);
                return { status: 'error', agent: agent.name, reason: msg, fallback: `${agent.name} ${isTimeout ? 'timed out' : 'failed'} — manual review required.` };
            }
        },
    });
}

// ── Timed specialist agent tools ───────────────────────────────────────────────

const healthMemoryTool      = createOpenRouterAgentTool(healthMemoryAgent);
const diagnosisTool         = createOpenRouterAgentTool(diagnosisAgent);
const intakeTool            = createOpenRouterAgentTool(intakeAgent);
const careNavigatorTool     = createOpenRouterAgentTool(careNavigatorAgent);
const socialBarrierTool     = createOpenRouterAgentTool(socialBarrierAgent);
const treatmentPlannerTool  = createOpenRouterAgentTool(treatmentPlannerAgent);
const insuranceBillingTool  = createOpenRouterAgentTool(insuranceBillingAgent);
const followupAdherenceTool = createOpenRouterAgentTool(followupAdherenceAgent);

// ── assembleMediCoreReport ─────────────────────────────────────────────────────
//
// Mandatory final step. The LLM synthesises all specialist outputs into the
// required schema fields, passes them here, and this tool returns the validated
// JSON string. The LLM then echoes that string as its final response, which
// appFactory.ts captures via isFinalResponse() — solving "(no response)".

const assembleMediCoreReport = new FunctionTool({
    name: 'assembleMediCoreReport',
    description:
        'MANDATORY FINAL STEP. Call this once all relevant specialist agents have been ' +
        'consulted. Pass in the synthesised data from every agent. Returns the validated ' +
        'structured MediCore patient report as a JSON string. After calling this tool, ' +
        'output its "report" field VERBATIM as your sole final response — no preamble, ' +
        'no markdown, no extra text.',
    parameters: z.object({
        patientQuery: z
            .string()
            .describe('The original patient query or chief complaint, verbatim from the user message.'),

        urgency: z
            .enum(['EMERGENCY', 'URGENT', 'ROUTINE', 'PREVENTIVE'])
            .describe(
                'Clinical urgency. EMERGENCY = immediate life threat. ' +
                'URGENT = same-day care needed. ROUTINE = standard scheduling. ' +
                'PREVENTIVE = wellness / screening.',
            ),

        possibleConditions: z
            .array(z.string())
            .describe('Possible diagnoses or conditions from diagnosis_agent. Empty array if unavailable.'),

        careRecommendations: z
            .array(z.string())
            .describe('Care pathway steps and referrals from care_navigator_agent.'),

        treatmentSuggestions: z
            .array(z.string())
            .describe('Evidence-based treatments from treatment_planner_agent. Include generic alternatives when affordability is flagged.'),

        costInsights: z
            .array(z.string())
            .describe('Insurance coverage, prior auth status, and cost estimates from insurance_billing_agent.'),

        followupPlan: z
            .array(z.string())
            .describe('Follow-up schedule and adherence actions from followup_adherence_agent.'),

        longitudinalHealthInsights: z
            .array(z.string())
            .describe('Historical patterns and cross-encounter context from health_memory_agent.'),

        socialBarrierInsights: z
            .array(z.string())
            .describe(
                'SDOH barriers identified by social_barrier_agent: transportation, financial hardship, ' +
                'food insecurity, housing, health literacy, social isolation. ' +
                'Empty array if no barriers identified or agent unavailable.',
            ),

        safetyWarnings: z
            .array(z.string())
            .describe(
                'Safety warnings, drug interactions, allergy flags, emergency alerts, ' +
                'or red flags surfaced by ANY agent. Include immediately if EMERGENCY.',
            ),

        nextSteps: z
            .array(z.string())
            .describe('Prioritised, actionable next steps for the patient and care team. Order by urgency.'),

        agentsConsulted: z
            .array(z.string())
            .describe('Names of all specialist agents consulted. List agents that errored as "agent_name (error)".'),
    }),
    execute: (input: {
        patientQuery: string;
        urgency: 'EMERGENCY' | 'URGENT' | 'ROUTINE' | 'PREVENTIVE';
        possibleConditions: string[];
        careRecommendations: string[];
        treatmentSuggestions: string[];
        costInsights: string[];
        followupPlan: string[];
        longitudinalHealthInsights: string[];
        socialBarrierInsights: string[];
        safetyWarnings: string[];
        nextSteps: string[];
        agentsConsulted: string[];
    }) => {
        const report = {
            patientSummary: {
                query:           input.patientQuery,
                processedAt:     new Date().toISOString(),
                agentsConsulted: input.agentsConsulted,
                orchestratedBy:  'MediCore Orchestrator v1.0',
            },
            possibleConditions:         input.possibleConditions,
            urgency:                    input.urgency,
            careRecommendations:        input.careRecommendations,
            treatmentSuggestions:       input.treatmentSuggestions,
            costInsights:               input.costInsights,
            followupPlan:               input.followupPlan,
            longitudinalHealthInsights: input.longitudinalHealthInsights,
            socialBarrierInsights:      input.socialBarrierInsights,
            safetyWarnings:             input.safetyWarnings,
            nextSteps:                  input.nextSteps,
        };

        // ── Assembly logging ─────────────────────────────────────────────────────
        const successAgents = input.agentsConsulted.filter(
            (a) => !a.includes('(unavailable)') && !a.includes('(error)'),
        );
        const failedAgents = input.agentsConsulted.filter(
            (a) => a.includes('(unavailable)') || a.includes('(error)'),
        );
        const queryPreview = input.patientQuery.slice(0, 80) +
            (input.patientQuery.length > 80 ? '…' : '');

        console.log(
            `[ORCHESTRATOR][AGENT_RESPONSE] assembly=complete urgency=${input.urgency} ` +
            `agentsOk=${successAgents.length} agentsFailed=${failedAgents.length} ` +
            `conditions=${input.possibleConditions.length} ` +
            `warnings=${input.safetyWarnings.length} ` +
            `nextSteps=${input.nextSteps.length}`,
        );
        console.log(
            `[ORCHESTRATOR][AGENT_RESPONSE] query="${queryPreview}" ` +
            `agentsOk=[${successAgents.join(', ')}]`,
        );

        if (failedAgents.length > 0) {
            console.error(
                `[ORCHESTRATOR][AGENT_ERROR] type=AGENT_FAILURE ` +
                `count=${failedAgents.length} failed=[${failedAgents.join(', ')}]`,
            );
        }

        if (input.urgency === 'EMERGENCY') {
            console.error(
                `[ORCHESTRATOR] EMERGENCY urgency detected — ` +
                `safetyWarnings=[${input.safetyWarnings.map((w) => `"${w.slice(0, 60)}"`).join(', ')}]`,
            );
        } else if (input.safetyWarnings.length > 0) {
            console.log(
                `[ORCHESTRATOR] safetyWarnings=${input.safetyWarnings.length}: ` +
                `[${input.safetyWarnings.map((w) => `"${w.slice(0, 60)}"`).join(', ')}]`,
            );
        }

        const serialised = JSON.stringify(report, null, 2);
        console.log(
            `[ORCHESTRATOR] Report serialised — ` +
            `bytes=${serialised.length} processedAt=${report.patientSummary.processedAt}`,
        );

        return { report: serialised };
    },
});

// ── Orchestrator instruction ───────────────────────────────────────────────────

const ORCHESTRATION_INSTRUCTION = `\
You are the MediCore Orchestrator — an enterprise-grade healthcare AI coordination engine.
You coordinate a team of specialist agents and produce ONE unified, structured patient report.

The patient's message is available in your conversation as the user's text.
Use that exact text as the basis for ALL specialist agent calls and for the patientQuery
field in assembleMediCoreReport.

════════════════════════════════════════════════════════════
 SPECIALIST AGENTS
════════════════════════════════════════════════════════════

  health_memory_agent       Longitudinal history, cross-encounter patterns, patient preferences.
  diagnosis_agent           FHIR-powered clinical analysis: conditions, meds, vitals, observations.
  intake_agent              Date/time, ICD-10-CM code lookups. No FHIR required.
  care_navigator_agent      Care pathways, referrals, transitions of care.
  social_barrier_agent      SDOH screening: transportation, financial, food, housing, literacy barriers.
  treatment_planner_agent   Evidence-based treatments, drug interaction checks, clinical guidelines.
  insurance_billing_agent   Eligibility, prior auth, cost estimation, billing guidance.
  followup_adherence_agent  Follow-up scheduling, adherence monitoring, proactive outreach.

════════════════════════════════════════════════════════════
 ORCHESTRATION PROTOCOL — FOLLOW IN ORDER
════════════════════════════════════════════════════════════

STEP 1 — EMERGENCY TRIAGE
  Scan the patient input for emergency keywords:
  chest pain | difficulty breathing | stroke | severe bleeding | unconscious |
  suicidal | overdose | heart attack | seizure | anaphylaxis
  → If detected: set urgency = EMERGENCY, add immediate safety warnings.
  → Continue all steps regardless — never skip agents for emergencies.

STEP 2 — MEMORY FIRST
  Call health_memory_agent with the patient query.
  Its output provides longitudinal context that shapes ALL downstream agents.
  Note any prior allergies, prior non-adherence, recurring conditions.

STEP 3 — CLINICAL ANALYSIS
  Call diagnosis_agent with the patient query plus relevant memory context.
  Extract: possible conditions, urgency signals, FHIR data availability.

STEP 4 — CODING
  Call intake_agent to look up ICD-10-CM codes for conditions identified in Step 3.

STEP 5 — CARE NAVIGATION
  Call care_navigator_agent informed by diagnosis + memory output.
  If urgency = EMERGENCY or URGENT: request expedited specialist referral.

STEP 6 — SOCIAL BARRIERS ASSESSMENT
  Call social_barrier_agent with the full patient context (memory + diagnosis + chief complaint).
  Always run this step — social barriers affect adherence for ALL urgency levels.
  Pass: patient query, any transportation/financial/housing signals from the context.
  Use output to inform treatment_planner_agent (affordability) and followup_adherence_agent.

STEP 7 — TREATMENT PLANNING
  Call treatment_planner_agent informed by diagnosis + memory + social_barrier output.
  If social_barrier_agent flagged financial/affordability barriers: request generic alternatives.
  If insurance_billing flags prior-auth requirements: align treatment plan accordingly.

STEP 8 — BILLING & COVERAGE
  Call insurance_billing_agent with the treatment suggestions from Step 7.
  Identify prior auth requirements and patient cost exposure.

STEP 9 — FOLLOW-UP
  Call followup_adherence_agent with diagnosis + treatment + memory + social_barrier context.
  If memory shows prior non-adherence OR social_barrier flags HIGH risk: request high-intensity plan.
  If social_barrier identified transportation barriers: include telehealth options in follow-up plan.

STEP 10 — FINAL ASSEMBLY (MANDATORY)
  Call assembleMediCoreReport with ALL synthesised data and the original patient query.
  Include socialBarrierInsights from social_barrier_agent output.
  Then output the "report" field VERBATIM as your final response.
  Raw JSON only. No preamble. No markdown. No extra text.

════════════════════════════════════════════════════════════
 CROSS-AGENT REASONING RULES
════════════════════════════════════════════════════════════

  • Memory shows prior allergy               → add to safetyWarnings; constrain treatmentSuggestions
  • Memory shows prior non-adherence         → escalate followupPlan intensity; add proactive outreach to nextSteps
  • Insurance shows affordability gap        → treatment must include generic/lower-cost alternatives
  • Diagnosis shows URGENT condition         → care_navigator must include specialist referral
  • Diagnosis shows EMERGENCY               → safetyWarnings must appear FIRST in nextSteps
  • Follow-up detects high no-show risk      → add "Schedule proactive reminder calls" to nextSteps
  • Social barrier: TRANSPORTATION HIGH      → add telehealth option to care and followup plans
  • Social barrier: FINANCIAL HIGH           → treatment must include generic/assistance-program alternatives
  • Social barrier: FOOD HIGH               → add food resource referral to careRecommendations
  • Social barrier: social_work_referral=true → add "Refer to social worker" to nextSteps (priority 1)

════════════════════════════════════════════════════════════
 CRITICAL RULES — NON-NEGOTIABLE
════════════════════════════════════════════════════════════

  1. For GREETINGS or SIMPLE conversational inputs (e.g. "hi", "hello", "how are you"):
     Respond directly with a brief, friendly message. Do NOT call any tools.
     Example: "Hello! I am the MediCore AI Orchestrator. How can I help with your patient today?"
  2. For CLINICAL QUERIES about a specific patient — run the full orchestration protocol
     (Steps 1–10 above). ALWAYS call assembleMediCoreReport as your LAST action.
  3. ALWAYS output only the JSON from assembleMediCoreReport for clinical queries — nothing else.
  4. FHIR UNAVAILABILITY IS NOT A STOP SIGNAL — if an agent says "FHIR context not
     available", that is a partial response, not a failure. Use what the agent returned
     and IMMEDIATELY continue to the NEXT step. Do NOT stop orchestrating.
  6. AGENT FAILURE HANDLING — when a tool returns { "status": "error" }:
     - Use the "fallback" field as the output for that agent's report section.
     - Record the agent as "agent_name (unavailable)" in agentsConsulted.
     - Do NOT retry the failed agent. Continue IMMEDIATELY to the next step.
     - For social_barrier_agent failure: set socialBarrierInsights to [].
  7. If NO patient context is available at all, still call assembleMediCoreReport
     with urgency = ROUTINE and safe placeholder values.
  8. ANTI-LOOP — call each specialist agent AT MOST ONCE per session.
     Never call the same agent twice, even if its response was empty or errored.
  9. HARD CALL LIMIT — if you have made 10 or more tool calls total without yet
     calling assembleMediCoreReport, call it IMMEDIATELY using all data collected.
     Do not make any further specialist agent calls after this point.
  10. TIMEOUT CONTINUATION — a timeout response means the agent is unavailable,
      not that the patient data is wrong. Record it and proceed.

════════════════════════════════════════════════════════════
 URGENCY SCALE
════════════════════════════════════════════════════════════

  EMERGENCY  — Immediate life threat. 911 / ED now.
  URGENT     — Same-day or next-day care required.
  ROUTINE    — Standard scheduling within days to weeks.
  PREVENTIVE — Wellness / screening. No active complaint.
`;

// ── Orchestrator agent ─────────────────────────────────────────────────────────

export const rootAgent = new LlmAgent({
    name: 'orchestrator',
    model: new OpenRouterLlm(),
    description:
        'MediCore Orchestrator — enterprise clinical decision coordination engine. ' +
        'Routes patient queries through 7 specialist agents (health memory, diagnosis, ' +
        'intake coding, care navigation, treatment planning, affordability-aware insurance ' +
        'billing, and follow-up adherence intelligence) over an interoperable A2A ' +
        'multi-agent architecture. Synthesises longitudinal patient intelligence into a ' +
        'single structured clinical report.',
    instruction: ORCHESTRATION_INSTRUCTION,
    tools: [
        healthMemoryTool,
        diagnosisTool,
        intakeTool,
        careNavigatorTool,
        socialBarrierTool,
        treatmentPlannerTool,
        insuranceBillingTool,
        followupAdherenceTool,
        assembleMediCoreReport,
    ],
});
