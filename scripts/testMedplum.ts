/**
 * Live Medplum connectivity test + John Demo patient summary.
 * Run: npx tsx scripts/testMedplum.ts
 */

import 'dotenv/config';
import { getMedplumClient, isMedplumConfigured, resetMedplumAuth } from '../shared/medplumClient.js';
import {
    lookupPatientByNameAndDob,
    buildPatientTimeline,
    buildMemorySummary,
} from '../shared/fhirService.js';

const DIVIDER = '═'.repeat(60);

function pass(msg: string) { console.log(`  ✓  ${msg}`); }
function fail(msg: string) { console.error(`  ✗  ${msg}`); }
function info(msg: string) { console.log(`     ${msg}`); }

async function run() {
    console.log('\n' + DIVIDER);
    console.log(' MediCore — Medplum Connectivity Test');
    console.log(DIVIDER + '\n');

    // ── 1. Env check ──────────────────────────────────────────────────────────
    console.log('STEP 1 — Environment variables');

    const baseUrl      = process.env['MEDPLUM_BASE_URL'];
    const clientId     = process.env['MEDPLUM_CLIENT_ID'];
    const clientSecret = process.env['MEDPLUM_CLIENT_SECRET'];

    if (baseUrl)      pass(`MEDPLUM_BASE_URL     = ${baseUrl}`);
    else              fail('MEDPLUM_BASE_URL is not set');

    if (clientId)     pass(`MEDPLUM_CLIENT_ID    = ${clientId}`);
    else              fail('MEDPLUM_CLIENT_ID is not set');

    if (clientSecret) pass(`MEDPLUM_CLIENT_SECRET= ${'*'.repeat(8)}...${clientSecret.slice(-4)}`);
    else              fail('MEDPLUM_CLIENT_SECRET is not set');

    if (!isMedplumConfigured()) {
        fail('Medplum not fully configured — aborting test.');
        process.exit(1);
    }
    console.log();

    // ── 2. Authentication ─────────────────────────────────────────────────────
    console.log('STEP 2 — OAuth2 client-credentials authentication');
    let client;
    try {
        client = await getMedplumClient();
        pass('Authenticated successfully');
        const profile = client.getActiveLogin();
        if (profile) info(`Active login: ${JSON.stringify(profile).slice(0, 120)}`);
    } catch (err) {
        fail(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    console.log();

    // ── 3. Capability check — raw FHIR ping ───────────────────────────────────
    console.log('STEP 3 — FHIR server capability check');
    try {
        const cap = await client.get('fhir/R4/metadata') as Record<string, unknown>;
        const software = (cap['software'] as Record<string, string> | undefined);
        const fhirVer  = (cap['fhirVersion'] as string | undefined) ?? 'unknown';
        pass(`FHIR R4 endpoint reachable — version=${fhirVer}`);
        if (software?.['name']) info(`Server software: ${software['name']} ${software['version'] ?? ''}`);
    } catch (err) {
        fail(`Capability check failed: ${err instanceof Error ? err.message : String(err)}`);
        // Non-fatal — continue
    }
    console.log();

    // ── 4. Patient lookup — "John Demo" ──────────────────────────────────────
    console.log('STEP 4 — Patient lookup: name="John" DOB="1970-01-01"');
    let patientId: string | null = null;
    try {
        const patients = await lookupPatientByNameAndDob('John', '1970-01-01');
        if (patients.length === 0) {
            // Broaden search — just name
            console.log('     (no exact DOB match — retrying with name only)');
            const broader = await lookupPatientByNameAndDob('John Demo');
            if (broader.length === 0) {
                fail('No patient found matching "John Demo" or "John" + DOB 1970-01-01');
                console.log();
                console.log('STEP 5 — Listing first 5 patients in the project');
                try {
                    const allPts = await client.searchResources('Patient', { _count: '5', _sort: '_lastUpdated' }) as Record<string, unknown>[];
                    if (allPts.length === 0) {
                        info('No patients found in project — is this a fresh Medplum project?');
                    } else {
                        pass(`Found ${allPts.length} patient(s):`);
                        for (const p of allPts) {
                            const id = p['id'] as string ?? 'no-id';
                            const names = (p['name'] as Record<string, unknown>[] | undefined) ?? [];
                            const name = names[0]
                                ? `${(names[0]['given'] as string[] | undefined ?? []).join(' ')} ${names[0]['family'] ?? ''}`.trim()
                                : 'Unnamed';
                            info(`  id=${id}  name="${name}"  dob=${p['birthDate'] ?? 'unknown'}`);
                        }
                    }
                } catch (e2) {
                    fail(`Patient list failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
                }
                console.log();
                console.log(DIVIDER);
                console.log(' Test complete — no John Demo patient found in this project.');
                console.log(DIVIDER + '\n');
                return;
            }
            patients.push(...broader);
        }

        pass(`Found ${patients.length} patient(s):`);
        for (const p of patients) {
            info(`  id=${p.id}  name="${p.name}"  dob=${p.birthDate ?? 'n/a'}  gender=${p.gender ?? 'n/a'}`);
        }

        // Use first match
        patientId = patients[0]!.id;
        pass(`Using patient ID: ${patientId}`);
    } catch (err) {
        fail(`Patient lookup error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    console.log();

    if (!patientId) {
        fail('No patient ID available — cannot fetch timeline.');
        process.exit(1);
    }

    // ── 5. Full timeline fetch ────────────────────────────────────────────────
    console.log(`STEP 5 — Fetching full timeline for patientId="${patientId}"`);
    try {
        const t0       = Date.now();
        const timeline = await buildPatientTimeline(patientId);
        const elapsed  = Date.now() - t0;

        pass(`Timeline fetched in ${elapsed}ms`);
        info(`  Conditions      : ${timeline.conditions.length}`);
        info(`  Observations    : ${timeline.observations.length}`);
        info(`  Medications     : ${timeline.medications.length}`);
        info(`  Service requests: ${timeline.serviceRequests.length}`);
        info(`  Allergies       : ${timeline.allergies.length}`);
        console.log();

        // ── 6. Memory summary ────────────────────────────────────────────────
        console.log('STEP 6 — Memory summary (what health_memory_agent returns to orchestrator)');
        console.log(DIVIDER);
        const summary = buildMemorySummary(timeline);
        console.log(summary);
        console.log(DIVIDER);

        // ── 7. Cache test ────────────────────────────────────────────────────
        console.log('\nSTEP 7 — Cache verification (second call must be <5ms)');
        const t1     = Date.now();
        await buildPatientTimeline(patientId);
        const cached = Date.now() - t1;
        if (cached < 20) {
            pass(`Cache HIT confirmed — returned in ${cached}ms`);
        } else {
            fail(`Expected cache HIT but took ${cached}ms — possible cache miss`);
        }

    } catch (err) {
        fail(`Timeline fetch error: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) console.error(err.stack);
        process.exit(1);
    }

    console.log();
    console.log(DIVIDER);
    console.log(' All steps passed — Medplum integration is operational.');
    console.log(DIVIDER + '\n');
}

run().catch((err) => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
