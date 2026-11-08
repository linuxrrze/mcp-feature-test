#!/usr/bin/env node
/** stdio entry point: `node dist/stdio.js` (what Claude Desktop, Claude Code, VS Code, Cursor … launch). */
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { printImageBanner } from './banner.js';
import { maxRequestBodyBytes } from './files.js';
import { errorData, logger } from './log.js';
import { createFeatureTestServer } from './server.js';

printImageBanner(); // stderr only

// Never write to stdout in stdio mode – it is the protocol channel. The logger writes to stderr.
serveStdio(() => createFeatureTestServer({ transport: 'stdio' }), {
    // One message must fit a maximum-size upload (UPLOAD_MAX_BYTES, as base64); the SDK default is 10 MB.
    transport: new StdioServerTransport(undefined, undefined, { maxBufferSize: Math.max(STDIO_DEFAULT_MAX_BUFFER_SIZE, maxRequestBodyBytes()) }),
    onerror: e => logger.warn('stdio', e.message, errorData(e))
});
logger.info('stdio.ready', 'serving MCP on stdio', { pid: process.pid });
