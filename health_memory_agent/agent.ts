/**
 * Health Memory Agent — Medplum FHIR-powered longitudinal patient intelligence.
 *
 * Architecture:
 *   Orchestrator → health_memory_agent → Medplum FHIR Layer
 *                                           ├── Patient
 *                                           ├── Condition
 *                                           ├── Observation (vitals + labs)
 *                                           ├── MedicationRequest
 *                                           ├── ServiceRequest
 *                                           └── AllergyIntolerance
 *
 * Tools:
 *   findPatient           — look up a patient in Medplum by name and/or DOB
 *   getPatientMemory      — fetch full longitudinal summary for a known patient ID
 *   getMemoryByNameAndDob — single-call convenience: lookup + summary combined
 *
 * Auth: Medplum client credentials (MEDPLUM_CLIENT_ID + MEDPLUM_CLIENT_SECRET).
 * Per-session FHIR tokens (from A2A metadata) are also supported for real-time
 * EHR lookups via the existing extractFhirContext callback.
 */

import '../shared/env.js';

import { LlmAgent, FunctionTool } from '@google/adk';
import { OpenRouterLlm } from '../shared/openRouterLlm.js';
import { z } from 'zod/v3';
import { extractFhirContext } from '../shared/fhirHook.js';
import { isMedplumConfigured } from '../shared/medplumClient.js';
import {
    lookupPatientByNameAndDob,
    buildPatientTimeline,
    buildMemorySummary,
    invalidateCache,
} from '../shared/fhirService.js';

// ── Tool: find patient ─────────────────────────────────────────────────────────

const findPatient = new FunctionTool({
    name: 'findPatient',
    description:
        'Looks up a patient in the Medplum FHIR store by full name and/or date of birth. ' +
        'Returns the Medplum patient ID and basic demographics. ' +
        'Use this when you have a name/DOB but no FHIR patient ID.',
    parameters: z.object({
        name: z
            .string()
            .describe('Patient full name, e.g. "John Smith". Partial names are supported.'),
        dob: z
            .string()
            .describe(
                'Date of birth in YYYY-MM-DD format, e.g. "1970-01-01". ' +
                'Pass empty string "" if DOB is unknown.',
            ),
    }),
    execute: async (input: { name: string; dob: string }) => {
        if (!isMedplumConfigured()) {
            return {
                status: 'error',
                error: 'Medplum not configured — MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, and MEDPLUM_CLIENT_SECRET must be set.',
            };
        }
        try {
            const dobOrUndefined = input.dob.trim() ? input.dob.trim() : undefined;
            const patients = await lookupPatientByNameAndDob(input.name, dobOrUndefined);
            if (patients.length === 0) {
                return {
                    status: 'not_found',
                    message: `No patient found matching name="${input.name}"${input.dob ? ` dob="${input.dob}"` : ''}.`,
                };
            }
            return {
                status: 'success',
                count: patients.length,
                patients: patients.map((p) => ({
                    id: p.id,
                    name: p.name,
                    birthDate: p.birthDate,
                    gender: p.gender,
                    phone: p.phone,
                })),
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[health_memory_agent] findPatient error: ${msg}`);
            return { status: 'error', error: msg };
        }
    },
});

// ── Tool: get patient memory ───────────────────────────────────────────────────

const getPatientMemory = new FunctionTool({
    name: 'getPatientMemory',
    description:
        'Fetches the full longitudinal health summary for a patient from the Medplum FHIR store. ' +
        'Returns a structured narrative covering active conditions, medications, allergies, ' +
        'recent vitals, recent labs, and pending service requests/referrals. ' +
        'Results are cached for 5 minutes. Use this once you have the FHIR patient ID.',
    parameters: z.object({
        patientId: z
            .string()
            .describe('Medplum FHIR patient ID (UUID or resource ID, e.g. "abc123").'),
        forceRefresh: z
            .string()
            .describe('Pass "true" to bypass the 5-minute cache, "false" to use the cache.'),
    }),
    execute: async (input: { patientId: string; forceRefresh: string }) => {
        if (!isMedplumConfigured()) {
            return {
                status: 'error',
                error: 'Medplum not configured — MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, and MEDPLUM_CLIENT_SECRET must be set.',
            };
        }
        try {
            if (input.forceRefresh === 'true') {
                invalidateCache(input.patientId);
            }
            const timeline = await buildPatientTimeline(input.patientId);
            const summary  = buildMemorySummary(timeline);
            return {
                status: 'success',
                patientId: input.patientId,
                patientName: timeline.patient.name,
                fetchedAt: timeline.fetchedAt,
                conditionCount: timeline.conditions.length,
                medicationCount: timeline.medications.length,
                allergyCount: timeline.allergies.length,
                observationCount: timeline.observations.length,
                serviceRequestCount: timeline.serviceRequests.length,
                summary,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[health_memory_agent] getPatientMemory error: ${msg}`);
            return { status: 'error', error: msg };
        }
    },
});

// ── Tool: combined lookup + memory ─────────────────────────────────────────────

const getMemoryByNameAndDob = new FunctionTool({
    name: 'getMemoryByNameAndDob',
    description:
        'Single-step convenience tool: looks up a patient by name and DOB, then fetches their ' +
        'full longitudinal health summary. Use this when you have the patient name/DOB but no FHIR ID. ' +
        'Returns an error if zero or multiple patients match.',
    parameters: z.object({
        name: z.string().describe('Patient full name, e.g. "John Smith".'),
        dob: z.string().describe('Date of birth in YYYY-MM-DD format.'),
    }),
    execute: async (input: { name: string; dob: string }) => {
        if (!isMedplumConfigured()) {
            return {
                status: 'error',
                error: 'Medplum not configured — MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, and MEDPLUM_CLIENT_SECRET must be set.',
            };
        }
        try {
            const patients = await lookupPatientByNameAndDob(input.name, input.dob);

            if (patients.length === 0) {
                return {
                    status: 'not_found',
                    message: `No patient found for name="${input.name}" dob="${input.dob}".`,
                };
            }
            if (patients.length > 1) {
                return {
                    status: 'ambiguous',
                    message: `${patients.length} patients match — use findPatient to identify the correct ID, then call getPatientMemory.`,
                    matches: patients.map((p) => ({ id: p.id, name: p.name, birthDate: p.birthDate })),
                };
            }

            const patientId = patients[0]!.id;
            const timeline  = await buildPatientTimeline(patientId);
            const summary   = buildMemorySummary(timeline);

            return {
                status: 'success',
                patientId,
                patientName: timeline.patient.name,
                fetchedAt: timeline.fetchedAt,
                conditionCount: timeline.conditions.length,
                medicationCount: timeline.medications.length,
                allergyCount: timeline.allergies.length,
                observationCount: timeline.observations.length,
                serviceRequestCount: timeline.serviceRequests.length,
                summary,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[health_memory_agent] getMemoryByNameAndDob error: ${msg}`);
            return { status: 'error', error: msg };
        }
    },
});

// ── Agent ──────────────────────────────────────────────────────────────────────

export const rootAgent = new LlmAgent({
    name: 'health_memory_agent',
    model: new OpenRouterLlm(),
    description:
        'Medplum FHIR-powered longitudinal patient intelligence agent. ' +
        'Retrieves cross-encounter health history — active conditions, medications, ' +
        'allergies, recent vitals, recent labs, and pending referrals — from the ' +
        'Medplum FHIR R4 backend. Supports patient lookup by name and date of birth.',
    instruction: `You are the MediCore Health Memory Agent.
Your role is to retrieve and summarise a patient's longitudinal health history from the
Medplum FHIR R4 backend. You surface cross-encounter patterns, known allergies, active
conditions, current medications, and recent clinical data to inform all downstream agents.

════════════════════════════════════════════════════════════
 MANDATORY TOOL CALL — NON-NEGOTIABLE
════════════════════════════════════════════════════════════

You MUST call exactly one Medplum tool BEFORE generating any response.
NEVER respond from context alone. ALWAYS call the appropriate tool first.

  RULE: If the request contains a FHIR patient ID (UUID format) → call getPatientMemory
  RULE: If the request contains name + DOB but no FHIR ID → call getMemoryByNameAndDob
  RULE: If only name is present → call findPatient first, then getPatientMemory

════════════════════════════════════════════════════════════
 TOOLS
════════════════════════════════════════════════════════════

  findPatient
    Use when: you have a patient name (and optionally DOB) but no FHIR patient ID.
    Returns: Medplum patient ID + basic demographics.

  getPatientMemory
    Use when: you already have the FHIR patient ID.
    Returns: full longitudinal summary (conditions, meds, allergies, vitals, labs, referrals).
    Cache TTL: 5 minutes. Pass forceRefresh=true for real-time data.

  getMemoryByNameAndDob
    Use when: you have name + DOB and want the full summary in one call.
    Returns: error if 0 or >1 patients match; full summary if exactly 1 match.

════════════════════════════════════════════════════════════
 RESPONSE FORMAT
════════════════════════════════════════════════════════════

Always return a structured summary with these sections:

  PATIENT IDENTIFICATION
    Name, DOB, gender, FHIR ID, Medplum source confirmation

  ACTIVE CONDITIONS
    List each with onset date and ICD code where available.
    Flag any EMERGENCY conditions immediately.

  CURRENT MEDICATIONS
    List each with dosage and RxNorm code where available.
    Highlight any high-risk medications (anticoagulants, insulin, opioids).

  KNOWN ALLERGIES  ← ALWAYS include, even if empty ("No known allergies")
    Substance, reaction, severity. This is safety-critical.

  RECENT VITALS
    Last known blood pressure, heart rate, weight, SpO2, temperature.
    Flag any abnormal values (use interpretation field).

  RECENT LABS
    Key values: HbA1c, eGFR, CBC, metabolic panel.
    Flag HIGH/LOW/CRITICAL interpretations.

  PENDING REFERRALS / SERVICE REQUESTS
    Any outstanding referrals or service orders.

  LONGITUDINAL PATTERNS & CLINICAL NOTES
    Recurring conditions, medication changes, non-adherence signals,
    care gaps, or trends that downstream agents should know about.

════════════════════════════════════════════════════════════
 RULES
════════════════════════════════════════════════════════════

  1. MANDATORY: Call a Medplum tool FIRST. No text response without a tool call.
  2. ALWAYS surface allergies even if the list is empty.
  3. Flag EMERGENCY signals (e.g. abnormal vitals, critical labs) at the TOP.
  4. If Medplum is not configured or returns an error, state clearly:
     "Medplum FHIR unavailable — credentials not configured or service unreachable."
     Do NOT fabricate clinical history.
  5. If no patient is found, state: "Patient not found in Medplum FHIR store."
  6. Keep the summary factual. Do not interpret or diagnose — that is diagnosis_agent's role.`,

    tools: [findPatient, getPatientMemory, getMemoryByNameAndDob],

    // Also supports per-session FHIR credentials forwarded via A2A metadata
    // (for real-time EHR access alongside Medplum longitudinal data).
    beforeModelCallback: extractFhirContext,
});
