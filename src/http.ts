#!/usr/bin/env node
/**
 * Streamable HTTP entry point: `node dist/http.js` → http://127.0.0.1:3457/mcp
 *
 * Env:
 *   PORT          listen port (default 3457; 0 = pick a free port)
 *   HOST          bind address (default 127.0.0.1; use 0.0.0.0 in containers)
 *   PUBLIC_URL    externally visible base URL, used for URL-elicitation pages
 *                 and in logs (default http://<host>:<port>)
 *   ALLOWED_HOSTS comma-separated hostnames accepted in Host/Origin headers
 *   LOG_LEVEL / LOG_FORMAT, see log.ts
 */
import { printImageBanner } from './banner.js';
import { errorData, logger } from './log.js';
import { parseAllowedHosts, startHttpServer } from './httpServer.js';

printImageBanner();

try {
    const running = await startHttpServer({
        port: Number(process.env.PORT ?? 3457),
        host: process.env.HOST ?? '127.0.0.1',
        publicUrl: process.env.PUBLIC_URL || undefined,
        allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS)
    });

    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        logger.info('http.shutdown', `${signal} received, closing`);
        const force = setTimeout(() => process.exit(0), 3000);
        force.unref();
        await running.close().catch(e => logger.warn('http.shutdown', 'close failed', errorData(e)));
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (e) {
    logger.error('http.start', 'could not start the HTTP server', errorData(e));
    process.exit(1);
}
