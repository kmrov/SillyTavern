/** Resolve server-only placeholders in Custom Chat Completion headers. */
export function resolveCustomSecretHeaders(headers, customSecret, environment = process.env) {
    for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== 'string') continue;
        headers[name] = value.replace(/\$\{(ENV|SECRET):([A-Z0-9_]+)\}/g, (_match, kind, key) => {
            if (kind === 'SECRET' && key === 'CUSTOM') {
                if (!customSecret) throw new Error('Custom Chat Completion secret is not configured.');
                return customSecret;
            }
            if (kind === 'ENV' && key.startsWith('SILLYTAVERN_CUSTOM_')) {
                if (!environment[key]) throw new Error(`Custom Chat Completion environment variable ${key} is not set.`);
                return environment[key];
            }
            throw new Error(`Custom Chat Completion placeholder ${kind}:${key} is not allowed.`);
        });
    }
    return headers;
}
