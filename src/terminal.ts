import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { PluginError } from "./errors.js";

/** Secrets are entered in a real terminal, never through MCP stdin or chat. */
export async function terminalQuestion(label: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY)
    throw new PluginError(
      "terminal_required",
      "Run setup in your own terminal. Do not paste a token into chat or pipe it to this command.",
    );
  const mute = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: hidden ? mute : process.stderr,
    terminal: true,
    historySize: 0,
  });
  const abort = new AbortController();
  let answered = false;
  rl.once("SIGINT", () => abort.abort());
  rl.once("close", () => {
    if (!answered) abort.abort();
  });
  // Disable terminal echo before showing the prompt: an immediate paste must be hidden too.
  process.stderr.write(label);
  try {
    const value = await rl.question("", { signal: abort.signal });
    answered = true;
    return value.trim();
  } catch {
    throw new PluginError("setup_cancelled", "Setup cancelled. No token was saved.");
  } finally {
    rl.close();
    if (hidden) process.stderr.write("\n");
  }
}
