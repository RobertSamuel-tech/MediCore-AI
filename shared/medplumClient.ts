/**
 * Medplum FHIR client — singleton with OAuth2 client-credentials auth.
 *
 * Authenticates once using MEDPLUM_CLIENT_ID + MEDPLUM_CLIENT_SECRET,
 * then reuses the same client for all requests. The MedplumClient SDK
 * handles token refresh automatically.
 *
 * Required env vars:
 *   MEDPLUM_BASE_URL         e.g. https://api.medplum.com
 *   MEDPLUM_CLIENT_ID        OAuth2 client ID
 *   MEDPLUM_CLIENT_SECRET    OAuth2 client secret
 */

import './env.js';
import { MedplumClient } from '@medplum/core';

let _client: MedplumClient | null = null;
let _authenticated = false;

/** Returns true if all three Medplum env vars are set. */
export function isMedplumConfigured(): boolean {
    return Boolean(
        process.env['MEDPLUM_BASE_URL'] &&
        process.env['MEDPLUM_CLIENT_ID'] &&
        process.env['MEDPLUM_CLIENT_SECRET'],
    );
}

/**
 * Returns an authenticated MedplumClient.
 * Authenticates on first call; subsequent calls return the cached client.
 * Throws if env vars are missing.
 */
export async function getMedplumClient(): Promise<MedplumClient> {
    if (!isMedplumConfigured()) {
        throw new Error(
            '[Medplum] Not configured — set MEDPLUM_BASE_URL, ' +
            'MEDPLUM_CLIENT_ID, and MEDPLUM_CLIENT_SECRET in .env',
        );
    }

    if (!_client) {
        const baseUrl = process.env['MEDPLUM_BASE_URL']!.replace(/\/$/, '') + '/';
        _client = new MedplumClient({ baseUrl });
        console.info(`[Medplum] Client created → ${baseUrl}`);
    }

    if (!_authenticated) {
        const clientId     = process.env['MEDPLUM_CLIENT_ID']!;
        const clientSecret = process.env['MEDPLUM_CLIENT_SECRET']!;
        // Hard timeout on the auth call — if Medplum is unreachable this would
        // otherwise hang for 60+ seconds, blocking the entire agent response.
        await Promise.race([
            _client.startClientLogin(clientId, clientSecret),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('[Medplum] Auth timeout — server did not respond within 5s')), 5_000),
            ),
        ]);
        _authenticated = true;
        console.info('[Medplum] Authenticated via client credentials');
    }

    return _client;
}

/** Force re-authentication on next call (e.g. after a 401). */
export function resetMedplumAuth(): void {
    _authenticated = false;
    _client = null;
    console.warn('[Medplum] Auth reset — will re-authenticate on next request');
}
