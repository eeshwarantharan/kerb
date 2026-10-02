// kerb mcp: the read-only MCP server over stdio (KERB-V2 11.2). Agents start it; `kerb init`
// registers it where the agent supports MCP.
import { parseOpts } from './args.js';
import { createServer } from '../platform/mcp.js';

export default async function mcp(ctx, args) {
  parseOpts(args, {});
  const server = createServer({ cwd: ctx.cwd, env: ctx.env });
  await server.serve(ctx.stdin || process.stdin, ctx.stdout);
  return 0;
}
