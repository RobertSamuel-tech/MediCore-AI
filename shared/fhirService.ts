/**
 * FHIR service layer — Medplum-backed longitudinal patient data.
 *
 * Fetches Patient, Condition, Observation, MedicationRequest,
 * ServiceRequest, and AllergyIntolerance resources from Medplum FHIR R4.
 *
 * Features:
 *   • 5-minute in-memory timeline cache keyed by patient ID
 *   • Exponential-backoff retry (3 attempts, 500ms/1000ms delays)
 *   • Patient lookup by name + date-of-birth
 *   • Structured PatientTimeline + plain-text memory summary
 */

import { getMedplumClient, resetMedplumAuth } from './medplumClient.js';

// ── Output types ───────────────────────────────────────────────────────────────

export interface PatientDemographics {
    id: string;
    name: string;
    birthDate: string | null;
    gender: string | null;
    phone: string | null;
}

export interface ConditionEntry {
    name: string;
    icdCode: string | null;
    clinicalStatus: string | null;
    onsetDate: string | null;
    recordedDate: string | null;
}

export interface ObservationEntry {
    name: string;
    loincCode: string | null;
    value: string;
    unit: string | null;
    effectiveDate: string | null;
    interpretation: string | null;
    category: string | null;
}

export interface MedicationEntry {
    name: string;
    rxNormCode: string | null;
    status: string | null;
    dosage: string | null;
    authoredOn: string | null;
    prescriber: string | null;
}

export interface ServiceRequestEntry {
    name: string;
    status: string | null;
    intent: string | null;
    authoredOn: string | null;
    notes: string | null;
}

export interface AllergyEntry {
    substance: string;
    reactions: string[];
    severity: string | null;
    clinicalStatus: string | null;
}

export interface PatientTimeline {
    patient: PatientDemographics;
    conditions: ConditionEntry[];
    observations: ObservationEntry[];
    medications: MedicationEntry[];
    serviceRequests: ServiceRequestEntry[];
    allergies: AllergyEntry[];
    fetchedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type FhirResource = Record<string, unknown>;
type CodeableConcept = { text?: string; coding?: { code?: string; display?: string; system?: string }[] };

function codeText(cc?: CodeableConcept | null): string {
    if (!cc) return 'Unknown';
    if (cc.text) return cc.text;
    const codings = cc.coding ?? [];
    for (const c of codings) if (c.display) return c.display;
    return 'Unknown';
}

function codeValue(cc?: CodeableConcept | null, systemHint?: string): string | null {
    const codings = cc?.coding ?? [];
    for (const c of codings) {
        if (!systemHint || c.system?.includes(systemHint)) {
            return c.code ?? null;
        }
    }
    return codings[0]?.code ?? null;
}

function humanName(r: FhirResource): string {
    const names = (r['name'] as FhirResource[] | undefined) ?? [];
    const official = names.find((n) => n['use'] === 'official') ?? names[0];
    if (!official) return 'Unknown';
    const given = ((official['given'] as string[] | undefined) ?? []).join(' ');
    const family = (official['family'] as string | undefined) ?? '';
    return `${given} ${family}`.trim() || 'Unknown';
}

function firstPhone(r: FhirResource): string | null {
    const telecom = (r['telecom'] as FhirResource[] | undefined) ?? [];
    const phone = telecom.find((t) => t['system'] === 'phone');
    return (phone?.['value'] as string | undefined) ?? null;
}

// ── Retry ──────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 2;      // reduced from 3 — fast-fail is more important than retrying
const BASE_DELAY_MS = 300;
const FHIR_CALL_TIMEOUT_MS = 6_000;  // 6 s per individual FHIR call

/** Races the given async fn against a hard 6-second timeout. */
function withTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`[fhirService] TIMEOUT: ${label} did not respond within ${FHIR_CALL_TIMEOUT_MS}ms`)),
            FHIR_CALL_TIMEOUT_MS,
        );
        fn().then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

async function withRetry<T>(fn: () => Promise<T>, label = 'fhir_call'): Promise<T> {
    let lastErr: Error = new Error('Unknown error');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            return await withTimeout(fn, label);
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            const is401 = lastErr.message.includes('401') || lastErr.message.toLowerCase().includes('unauthorized');
            if (is401) resetMedplumAuth();
            if (attempt < MAX_ATTEMPTS - 1) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                console.warn(
                    `[fhirService] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${lastErr.message}). ` +
                    `Retrying in ${delay}ms…`,
                );
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

// ── Cache ──────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry { timeline: PatientTimeline; cachedAt: number; }
const _cache = new Map<string, CacheEntry>();

function getFromCache(patientId: string): PatientTimeline | null {
    const entry = _cache.get(patientId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) { _cache.delete(patientId); return null; }
    return entry.timeline;
}

function setCache(patientId: string, timeline: PatientTimeline): void {
    _cache.set(patientId, { timeline, cachedAt: Date.now() });
}

export function invalidateCache(patientId: string): void {
    _cache.delete(patientId);
}

// ── Patient lookup ─────────────────────────────────────────────────────────────

/**
 * Look up patients by full name and/or date-of-birth.
 * Returns an array of matching patient demographics (usually 0 or 1 results).
 */
export async function lookupPatientByNameAndDob(
    name: string,
    dob?: string,
): Promise<PatientDemographics[]> {
    return withRetry(async () => {
        const client = await getMedplumClient();

        const params: Record<string, string> = {};
        if (name.trim()) params['name'] = name.trim();
        if (dob?.trim()) params['birthdate'] = `eq${dob.trim()}`;

        const patients = await client.searchResources('Patient', params) as FhirResource[];
        console.info(`[fhirService] lookupPatient name="${name}" dob="${dob ?? ''}" → ${patients.length} result(s)`);

        return patients.map((p) => ({
            id: (p['id'] as string | undefined) ?? '',
            name: humanName(p),
            birthDate: (p['birthDate'] as string | undefined) ?? null,
            gender: (p['gender'] as string | undefined) ?? null,
            phone: firstPhone(p),
        }));
    });
}

// ── Resource fetchers ──────────────────────────────────────────────────────────

async function fetchConditions(patientId: string): Promise<ConditionEntry[]> {
    const client = await getMedplumClient();
    const resources = await client.searchResources('Condition', {
        patient: patientId,
        'clinical-status': 'active,recurrence,relapse',
        _count: '50',
        _sort: '-recorded-date',
    }) as FhirResource[];

    return resources.map((r) => {
        const code = r['code'] as CodeableConcept | undefined;
        const clinicalStatus = r['clinicalStatus'] as CodeableConcept | undefined;
        const onset = (r['onsetDateTime'] as string | undefined)
            ?? ((r['onsetPeriod'] as FhirResource | undefined)?.['start'] as string | undefined)
            ?? null;
        return {
            name: codeText(code),
            icdCode: codeValue(code, 'icd'),
            clinicalStatus: codeText(clinicalStatus) ?? null,
            onsetDate: onset,
            recordedDate: (r['recordedDate'] as string | undefined) ?? null,
        };
    });
}

async function fetchObservations(patientId: string): Promise<ObservationEntry[]> {
    const client = await getMedplumClient();
    // Fetch vitals + labs in parallel
    const [vitals, labs] = await Promise.all([
        client.searchResources('Observation', {
            patient: patientId,
            category: 'vital-signs',
            _sort: '-date',
            _count: '20',
        }) as Promise<FhirResource[]>,
        client.searchResources('Observation', {
            patient: patientId,
            category: 'laboratory',
            _sort: '-date',
            _count: '20',
        }) as Promise<FhirResource[]>,
    ]);

    return [...vitals, ...labs].map((r) => {
        const code = r['code'] as CodeableConcept | undefined;
        const vq = r['valueQuantity'] as FhirResource | undefined;
        const vcc = r['valueCodeableConcept'] as CodeableConcept | undefined;
        const valueStr = vq
            ? `${vq['value']} ${vq['unit'] ?? vq['code'] ?? ''}`.trim()
            : vcc
                ? codeText(vcc)
                : (r['valueString'] as string | undefined) ?? 'N/A';

        const interp = ((r['interpretation'] as CodeableConcept[] | undefined) ?? [])[0];
        const catCodings = ((r['category'] as CodeableConcept[] | undefined) ?? [])[0];
        const effective = (r['effectiveDateTime'] as string | undefined)
            ?? ((r['effectivePeriod'] as FhirResource | undefined)?.['start'] as string | undefined)
            ?? null;

        return {
            name: codeText(code),
            loincCode: codeValue(code, 'loinc'),
            value: valueStr,
            unit: (vq?.['unit'] as string | undefined) ?? null,
            effectiveDate: effective,
            interpretation: interp ? codeText(interp) : null,
            category: catCodings ? codeText(catCodings) : null,
        };
    });
}

async function fetchMedications(patientId: string): Promise<MedicationEntry[]> {
    const client = await getMedplumClient();
    const resources = await client.searchResources('MedicationRequest', {
        patient: patientId,
        status: 'active,on-hold',
        _count: '50',
        _sort: '-authoredon',
    }) as FhirResource[];

    return resources.map((r) => {
        const medConcept = r['medicationCodeableConcept'] as CodeableConcept | undefined;
        const medRef = r['medicationReference'] as FhirResource | undefined;
        const name = medConcept
            ? codeText(medConcept)
            : (medRef?.['display'] as string | undefined) ?? 'Unknown';
        const dosageList = (r['dosageInstruction'] as FhirResource[] | undefined) ?? [];
        const requester = r['requester'] as FhirResource | undefined;
        return {
            name,
            rxNormCode: codeValue(medConcept, 'rxnorm'),
            status: (r['status'] as string | undefined) ?? null,
            dosage: (dosageList[0]?.['text'] as string | undefined) ?? null,
            authoredOn: (r['authoredOn'] as string | undefined) ?? null,
            prescriber: (requester?.['display'] as string | undefined) ?? null,
        };
    });
}

async function fetchServiceRequests(patientId: string): Promise<ServiceRequestEntry[]> {
    const client = await getMedplumClient();
    const resources = await client.searchResources('ServiceRequest', {
        patient: patientId,
        status: 'active,on-hold,draft',
        _count: '30',
        _sort: '-authored',
    }) as FhirResource[];

    return resources.map((r) => {
        const code = r['code'] as CodeableConcept | undefined;
        const notes = ((r['note'] as FhirResource[] | undefined) ?? [])
            .map((n) => n['text'] as string | undefined)
            .filter(Boolean)
            .join('; ') || null;
        return {
            name: codeText(code),
            status: (r['status'] as string | undefined) ?? null,
            intent: (r['intent'] as string | undefined) ?? null,
            authoredOn: (r['authoredOn'] as string | undefined) ?? null,
            notes,
        };
    });
}

async function fetchAllergies(patientId: string): Promise<AllergyEntry[]> {
    const client = await getMedplumClient();
    const resources = await client.searchResources('AllergyIntolerance', {
        patient: patientId,
        'clinical-status': 'active',
        _count: '30',
    }) as FhirResource[];

    return resources.map((r) => {
        const code = r['code'] as CodeableConcept | undefined;
        const clinicalStatus = r['clinicalStatus'] as CodeableConcept | undefined;
        const reactions = ((r['reaction'] as FhirResource[] | undefined) ?? []).flatMap((rxn) => {
            const manifestations = (rxn['manifestation'] as CodeableConcept[] | undefined) ?? [];
            return manifestations.map((m) => codeText(m));
        });
        const severity = ((r['reaction'] as FhirResource[] | undefined) ?? [])[0]?.['severity'] as string | undefined;
        return {
            substance: codeText(code),
            reactions,
            severity: severity ?? null,
            clinicalStatus: codeText(clinicalStatus) ?? null,
        };
    });
}

// ── Timeline builder ───────────────────────────────────────────────────────────

/**
 * Builds a full PatientTimeline by fetching all resource types in parallel.
 * Results are cached for 5 minutes.
 */
export async function buildPatientTimeline(patientId: string): Promise<PatientTimeline> {
    const cached = getFromCache(patientId);
    if (cached) {
        console.info(`[fhirService] Cache HIT for patientId=${patientId}`);
        return cached;
    }

    console.info(`[fhirService] Cache MISS — fetching timeline for patientId=${patientId}`);

    return withRetry(async () => {
        const client = await getMedplumClient();

        const [
            patientResource,
            conditions,
            observations,
            medications,
            serviceRequests,
            allergies,
        ] = await Promise.all([
            client.readResource('Patient', patientId) as Promise<FhirResource>,
            fetchConditions(patientId),
            fetchObservations(patientId),
            fetchMedications(patientId),
            fetchServiceRequests(patientId),
            fetchAllergies(patientId),
        ]);

        const patient: PatientDemographics = {
            id: patientId,
            name: humanName(patientResource),
            birthDate: (patientResource['birthDate'] as string | undefined) ?? null,
            gender: (patientResource['gender'] as string | undefined) ?? null,
            phone: firstPhone(patientResource),
        };

        const timeline: PatientTimeline = {
            patient,
            conditions,
            observations,
            medications,
            serviceRequests,
            allergies,
            fetchedAt: new Date().toISOString(),
        };

        setCache(patientId, timeline);
        console.info(
            `[fhirService] Timeline built for patientId=${patientId} — ` +
            `conditions=${conditions.length} obs=${observations.length} ` +
            `meds=${medications.length} serviceReqs=${serviceRequests.length} ` +
            `allergies=${allergies.length}`,
        );

        return timeline;
    });
}

// ── Memory summary ─────────────────────────────────────────────────────────────

/**
 * Converts a PatientTimeline into a structured plain-text narrative suitable
 * for inclusion in the health_memory_agent's LLM context.
 */
export function buildMemorySummary(t: PatientTimeline): string {
    const lines: string[] = [];

    // Patient header
    const age = t.patient.birthDate
        ? `${new Date().getFullYear() - new Date(t.patient.birthDate).getFullYear()} y/o`
        : null;
    const demo = [t.patient.name, age, t.patient.gender].filter(Boolean).join(', ');
    lines.push(`PATIENT: ${demo}`);
    if (t.patient.birthDate) lines.push(`DOB: ${t.patient.birthDate}`);
    if (t.patient.phone) lines.push(`Phone: ${t.patient.phone}`);
    lines.push(`FHIR ID: ${t.patient.id}`);
    lines.push('');

    // Conditions
    if (t.conditions.length > 0) {
        lines.push(`ACTIVE CONDITIONS (${t.conditions.length}):`);
        for (const c of t.conditions) {
            const code = c.icdCode ? ` [ICD: ${c.icdCode}]` : '';
            const onset = c.onsetDate ? ` onset: ${c.onsetDate}` : '';
            lines.push(`  • ${c.name}${code}${onset}`);
        }
        lines.push('');
    }

    // Medications
    if (t.medications.length > 0) {
        lines.push(`ACTIVE MEDICATIONS (${t.medications.length}):`);
        for (const m of t.medications) {
            const dosage = m.dosage ? ` — ${m.dosage}` : '';
            const rx = m.rxNormCode ? ` [RxNorm: ${m.rxNormCode}]` : '';
            lines.push(`  • ${m.name}${rx}${dosage}`);
        }
        lines.push('');
    }

    // Allergies — always surface early, safety-critical
    if (t.allergies.length > 0) {
        lines.push(`⚠ ALLERGIES (${t.allergies.length}):`);
        for (const a of t.allergies) {
            const rxn = a.reactions.length > 0 ? ` → ${a.reactions.join(', ')}` : '';
            const sev = a.severity ? ` (${a.severity})` : '';
            lines.push(`  • ${a.substance}${rxn}${sev}`);
        }
        lines.push('');
    }

    // Recent observations (capped at 10 per category for readability)
    if (t.observations.length > 0) {
        const vitals = t.observations.filter((o) => o.category?.toLowerCase().includes('vital'));
        const labs   = t.observations.filter((o) => o.category?.toLowerCase().includes('lab'));
        const other  = t.observations.filter((o) => !vitals.includes(o) && !labs.includes(o));

        if (vitals.length > 0) {
            lines.push(`RECENT VITALS (${Math.min(vitals.length, 10)} shown):`);
            for (const o of vitals.slice(0, 10)) {
                const interp = o.interpretation ? ` [${o.interpretation}]` : '';
                const date   = o.effectiveDate ? ` (${o.effectiveDate.slice(0, 10)})` : '';
                lines.push(`  • ${o.name}: ${o.value}${o.unit ? ' ' + o.unit : ''}${interp}${date}`);
            }
            lines.push('');
        }

        if (labs.length > 0) {
            lines.push(`RECENT LABS (${Math.min(labs.length, 10)} shown):`);
            for (const o of labs.slice(0, 10)) {
                const interp = o.interpretation ? ` [${o.interpretation}]` : '';
                const date   = o.effectiveDate ? ` (${o.effectiveDate.slice(0, 10)})` : '';
                lines.push(`  • ${o.name}: ${o.value}${o.unit ? ' ' + o.unit : ''}${interp}${date}`);
            }
            lines.push('');
        }

        if (other.length > 0) {
            lines.push(`OTHER OBSERVATIONS (${Math.min(other.length, 5)} shown):`);
            for (const o of other.slice(0, 5)) {
                lines.push(`  • ${o.name}: ${o.value}`);
            }
            lines.push('');
        }
    }

    // Service requests / referrals
    if (t.serviceRequests.length > 0) {
        lines.push(`PENDING SERVICE REQUESTS (${t.serviceRequests.length}):`);
        for (const s of t.serviceRequests) {
            const date = s.authoredOn ? ` (ordered: ${s.authoredOn.slice(0, 10)})` : '';
            const note = s.notes ? ` — ${s.notes.slice(0, 80)}` : '';
            lines.push(`  • ${s.name} [${s.status ?? 'unknown'}]${date}${note}`);
        }
        lines.push('');
    }

    lines.push(`— Fetched from Medplum FHIR at ${t.fetchedAt} —`);

    return lines.join('\n');
}
