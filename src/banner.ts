/**
 * Startup banner of the published container image.
 *
 * CI (.github/scripts/add-banner.sh, "builtin" mode) adds the rendered banner
 * text to the image at /usr/local/share/image-banner.txt; the Dockerfile sets
 * LABEL de.linux-ng.image-banner=builtin, so no shell wrapper is put in front
 * of the entrypoint. The banner goes to **stderr**: in stdio mode stdout is
 * the MCP protocol channel and must not carry anything else.
 */
import { readFileSync } from 'node:fs';

export const IMAGE_BANNER_FILE = '/usr/local/share/image-banner.txt';

/** Print the banner file if it exists (outside the image it normally doesn't). Never throws. */
export function printImageBanner(path = process.env.IMAGE_BANNER_FILE || IMAGE_BANNER_FILE, out: (s: string) => void = s => void process.stderr.write(s)): boolean {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return false;
    }
    if (!text) return false;
    out(text.endsWith('\n') ? text : `${text}\n`);
    return true;
}
