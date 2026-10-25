type StdioConsole = Pick<Console, "log" | "info" | "debug" | "error">;

/**
 * MCP's stdio transport owns stdout. Route application and dependency logs to
 * stderr so a human-readable line can never corrupt the JSON-RPC stream.
 */
export function reserveStdoutForMcp(target: StdioConsole = console): void {
  const stderr = target.error.bind(target);
  target.log = stderr;
  target.info = stderr;
  target.debug = stderr;
}
