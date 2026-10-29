import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { opaque } from "./hosted-store.js";

interface Session {
  owner: string;
  account: number;
  abort: AbortController;
  retired: boolean;
  permissions: string;
  protocol: Server;
  transport: StreamableHTTPServerTransport;
  touched: number;
  busy: number;
}

/** Only clients negotiating form elicitation need a persistent, bidirectional session. */
export class HostedMcp {
  private sessions = new Map<string, Session>();
  private cleanup: ReturnType<typeof setInterval>;
  constructor(
    private alive: (owner: string) => boolean,
    private now = Date.now,
  ) {
    this.cleanup = setInterval(() => this.prune(), 30_000);
    this.cleanup.unref();
  }
  private drop(id: string): void {
    const entry = this.sessions.get(id);
    this.sessions.delete(id);
    entry?.abort.abort();
    void entry?.protocol.close().catch(() => undefined);
  }
  private retire(id: string, entry: Session): void {
    entry.retired = true;
    entry.abort.abort();
    if (!entry.busy) this.drop(id);
  }
  prune(): void {
    for (const [id, entry] of this.sessions)
      if (!this.alive(entry.owner) || (!entry.busy && entry.touched + 10 * 60_000 <= this.now()))
        this.retire(id, entry);
  }
  close(): void {
    clearInterval(this.cleanup);
    for (const id of this.sessions.keys()) this.drop(id);
  }
  async handle(
    req: Request,
    res: Response,
    owner: string,
    permissions: string,
    account: number,
    create: (signal?: AbortSignal) => Server,
  ): Promise<void> {
    this.prune();
    const supplied = req.headers["mcp-session-id"];
    let id: string | undefined, entry: Session | undefined;
    if (supplied !== undefined) {
      entry = typeof supplied === "string" ? this.sessions.get(supplied) : undefined;
      // A session id never grants access, even to another grant in the same account.
      if (!entry || entry.owner !== owner) {
        res.sendStatus(404);
        return;
      }
      id = supplied as string;
      if (entry.retired || entry.permissions !== permissions) {
        this.retire(id, entry);
        res.sendStatus(404);
        return;
      }
    } else {
      if (req.method !== "POST") {
        res.sendStatus(405);
        return;
      }
      const init = InitializeRequestSchema.safeParse(req.body);
      const elicitation = init.success ? init.data.params.capabilities.elicitation : undefined;
      const form = elicitation && ("form" in elicitation || !Object.keys(elicitation).length);
      if (form) {
        if (
          this.sessions.size >= 100 ||
          [...this.sessions.values()].filter((s) => s.account === account).length >= 10 ||
          [...this.sessions.values()].filter((s) => s.owner === owner).length >= 5
        ) {
          res.status(429).send("Close an unused MCP connection before opening another.");
          return;
        }
        id = opaque();
        const abort = new AbortController();
        entry = {
          account,
          abort,
          retired: false,
          owner,
          permissions,
          protocol: create(abort.signal),
          touched: this.now(),
          busy: 0,
          transport: new StreamableHTTPServerTransport({
            sessionIdGenerator: () => id!,
            onsessionclosed: () => this.drop(id!),
          }),
        };
        // Reserve capacity before the first await, including parallel initialize requests.
        this.sessions.set(id, entry);
        try {
          await entry.protocol.connect(entry.transport as unknown as Transport);
        } catch (error) {
          this.drop(id);
          throw error;
        }
      }
    }
    if (!entry) {
      const protocol = create();
      try {
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        await protocol.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        await protocol.close();
      }
      return;
    }
    entry.busy++;
    entry.touched = this.now();
    const completed = new Promise<void>((resolve) => {
      res.once("finish", resolve);
      res.once("close", () => {
        // Losing a tool's response stream cancels outstanding confirmation prompts.
        if (!res.writableEnded) this.drop(id!);
        resolve();
      });
    });
    try {
      await entry.transport.handleRequest(req, res, req.body);
      await completed;
    } finally {
      entry.busy--;
      entry.touched = this.now();
      if (entry.retired && !entry.busy) this.drop(id!);
    }
  }
}
