/**
 * The version this server reports (serverInfo.version).
 *
 * CI builds the image with the release version (git tag vX.Y.Z, see
 * .github/scripts/next-version.sh) and passes it in as MCP_FEATURE_TEST_VERSION.
 * Outside such an image, package.json's version is used.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: unknown };
        return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

export function serverVersion(env: NodeJS.ProcessEnv = process.env): string {
    return env.MCP_FEATURE_TEST_VERSION?.trim() || packageVersion();
}
