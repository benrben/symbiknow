import { CopyButton } from './ConnectionCopy';
import type { McpInfo } from './connection-types';

export function ConnectionEndpoint({ info }: { info: McpInfo | null }) {
  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(endpoint);
  return <div className={`connection-banner${local ? ' connection-banner--warn' : ''}`}>
      <strong>Endpoint</strong><code>{endpoint}</code><CopyButton text={endpoint}/>
      <p><EndpointDescription info={info} local={local}/></p>
    </div>;
}

function EndpointDescription({ info, local }: { info: McpInfo | null; local: boolean }) {
  if (local) return <>This address only works on this computer. On your server, set PUBLIC_URL to the address agents use (for example https://symbiknow.example.com), bind with HOST=0.0.0.0 behind HTTPS, and set SYMBIKNOW_ACCESS_TOKEN to protect the workspace.</>;
  return <>Agents anywhere can connect over Streamable HTTP with a token.{info?.accessProtected ? ' The workspace is protected by an access token.' : ' Set SYMBIKNOW_ACCESS_TOKEN on the server so only your team can open the workspace.'} <EndpointSessions info={info}/></>;
}
function EndpointSessions({ info }: { info: McpInfo | null }) {
  if (!info?.activeSessions) return null;
  return <>{info.activeSessions} active MCP session{info.activeSessions === 1 ? '' : 's'}.</>;
}
