#!/usr/bin/env node
/** stdio entry point: `node dist/stdio.js` (what Claude Desktop, Claude Code, VS Code, Cursor … launch). */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { errorData, logger } from './log.js';
import { createFeatureTestServer } from './server.js';

// Never write to stdout in stdio mode – it is the protocol channel. The logger writes to stderr.
serveStdio(() => createFeatureTestServer({ transport: 'stdio' }), {
    onerror: e => logger.warn('stdio', e.message, errorData(e))
});
logger.info('stdio.ready', 'serving MCP on stdio', { pid: process.pid });
