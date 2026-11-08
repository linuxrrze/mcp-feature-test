/**
 * Minimal MCP Apps host for the browser test: embeds the app HTML in a
 * sandboxed srcdoc iframe and connects an AppBridge to it. Tool calls from the
 * app are proxied to a real MCP client living in Node (window.callTool), and
 * every app → host request is recorded in window.hostEvents.
 * Bundled on the fly by harness.mjs (esbuild).
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

interface HostConfig {
    theme: 'light' | 'dark';
    toolInput: Record<string, unknown>;
    /** Host capabilities to advertise; the default advertises everything the Dialog Lab uses. */
    hostCapabilities?: Record<string, unknown>;
    /** Tool result sent to the app (default: a plain "opened" text). */
    toolResult?: Record<string, unknown>;
    /** App → host methods this host leaves unhandled, so they answer "Method not found". */
    unsupported?: string[];
    /** Refuse this many tools/call requests first, like a user cancelling Open WebUI's "Tool call" confirmation. */
    refuseToolCalls?: number;
    /** availableDisplayModes in the host context (default inline + fullscreen). */
    displayModes?: string[];
    /** Content-Security-Policy put into the srcdoc as a <meta> tag (e.g. Open WebUI's). */
    csp?: string;
}
declare global {
    interface Window {
        callTool(p: unknown): Promise<any>;
        /** Optional: proxies the app's resources/read to the server. */
        readResource?(p: unknown): Promise<any>;
        appHtml: string;
        hostConfig: HostConfig;
        hostEvents: { type: string; params: unknown }[];
        hostReady: boolean;
    }
}

const cfg = window.hostConfig;
window.hostEvents = [];
const record = (type: string, params: unknown) => window.hostEvents.push({ type, params });
const context = (displayMode: 'inline' | 'fullscreen') => ({ theme: cfg.theme, displayMode, availableDisplayModes: cfg.displayModes ?? ['inline', 'fullscreen'] }) as any;

const iframe = document.getElementById('app') as HTMLIFrameElement;
// Host context must go in the constructor options: setHostContext() before connect() throws "Not connected".
const bridge = new AppBridge(
    null,
    { name: 'TestHost', version: '1.0.0' },
    (cfg.hostCapabilities ?? { openLinks: {}, serverTools: {}, logging: {}, updateModelContext: { text: {} }, message: { text: {} }, downloadFile: {} }) as any,
    { hostContext: context('inline') }
);
let refusals = cfg.refuseToolCalls ?? 0;
bridge.oncalltool = async p => {
    record('tools/call', p);
    if (refusals > 0) {
        refusals--;
        throw new Error('Tool call cancelled');
    }
    return window.callTool(p);
};
bridge.onmessage = async p => {
    record('ui/message', p);
    return {};
};
if (!cfg.unsupported?.includes('ui/update-model-context')) {
    bridge.onupdatemodelcontext = async p => {
        record('ui/update-model-context', p);
        return {};
    };
}
bridge.onrequestdisplaymode = async p => {
    record('ui/request-display-mode', p);
    bridge.setHostContext(context(p.mode as 'inline' | 'fullscreen'));
    return { mode: p.mode };
};
if (window.readResource) {
    bridge.onreadresource = async p => {
        record('resources/read', p);
        return window.readResource!(p);
    };
}
bridge.ondownloadfile = async p => {
    record('ui/download-file', p);
    return {};
};
bridge.oninitialized = () => {
    record('initialized', null);
    bridge.sendToolInput({ arguments: cfg.toolInput });
    bridge.sendToolResult((cfg.toolResult ?? { content: [{ type: 'text', text: 'opened' }] }) as any);
    window.hostReady = true;
};
iframe.addEventListener(
    'load',
    () => {
        void bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    },
    { once: true }
);
iframe.srcdoc = cfg.csp ? `<meta http-equiv="Content-Security-Policy" content="${cfg.csp.replace(/"/g, '&quot;')}">${window.appHtml}` : window.appHtml;
