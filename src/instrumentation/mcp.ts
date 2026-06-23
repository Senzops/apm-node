import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { getAiManager } from '../core/ai';

// ---------------------------------------------------------------------------
// Model Context Protocol (MCP) client instrumentation
// (`@modelcontextprotocol/sdk` Client)
//
// When an agent calls an MCP server, we record an `mcp` observation per call —
// directly answering "which MCP server / tool returned bad data?". We patch the
// client's `callTool` (tool invocation) and `readResource` (resource fetch),
// routing through `manager.mcp()` so the span nests under the active AI trace
// (e.g. inside `Senzor.ai.agent(...)`) or stands alone otherwise.
//
// Identity (server name, method, tool) is always recorded; the call result is
// captured only under the content-capture policy. An MCP `CallToolResult` can
// signal failure via `isError: true` on a RESOLVED promise — that is mapped to
// an error span without throwing (see AiManager.mcp `resultIsError`).
//
// Like the other framework hooks this rides the CJS require hook; for pure-ESM
// MCP clients the manual `Senzor.ai.mcp()` API is the guaranteed path.
// ---------------------------------------------------------------------------

const serverNameOf = (client: any): string => {
  try {
    const info =
      typeof client?.getServerVersion === 'function' ? client.getServerVersion() : client?._serverVersion;
    if (info?.name) return String(info.name);
  } catch {
    /* ignore — fall through to default */
  }
  return 'mcp-server';
};

const patchCallTool = (proto: any) => {
  if (!proto || typeof proto.callTool !== 'function') return;
  patchMethod(
    proto,
    'callTool',
    'senzor.mcp.callTool',
    (original) =>
      function patchedCallTool(this: any, params: any, ...rest: any[]) {
        const manager = getAiManager();
        if (!manager) return original.call(this, params, ...rest);
        try {
          return manager.mcp(
            { server: serverNameOf(this), method: 'tools/call', toolName: params?.name },
            () => original.call(this, params, ...rest)
          );
        } catch {
          return original.call(this, params, ...rest);
        }
      }
  );
};

const patchReadResource = (proto: any) => {
  if (!proto || typeof proto.readResource !== 'function') return;
  patchMethod(
    proto,
    'readResource',
    'senzor.mcp.readResource',
    (original) =>
      function patchedReadResource(this: any, params: any, ...rest: any[]) {
        const manager = getAiManager();
        if (!manager) return original.call(this, params, ...rest);
        try {
          return manager.mcp(
            { server: serverNameOf(this), method: 'resources/read', resourceUri: params?.uri },
            () => original.call(this, params, ...rest)
          );
        } catch {
          return original.call(this, params, ...rest);
        }
      }
  );
};

const patchClientProto = (exports: any) => {
  const proto = exports?.Client?.prototype;
  if (!proto) return;
  patchCallTool(proto);
  patchReadResource(proto);
};

export const instrumentMcp = (_options?: SenzorOptions) => {
  // The canonical import specifier is the explicit `.js` subpath; register the
  // extensionless form too for resolvers/bundlers that normalise it away.
  hookRequire('@modelcontextprotocol/sdk/client/index.js', patchClientProto);
  hookRequire('@modelcontextprotocol/sdk/client/index', patchClientProto);
};
