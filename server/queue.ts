import net from "node:net";
import type { Storage } from "./storage.js";
export type JobState =
  "queued" | "sending" | "sent" | "failed" | "outcome-unknown" | "cancelled";
export interface PrintJob {
  quantity?: number;
  batchId?: string;
  id: string;
  state: JobState;
  printer: any;
  zpl: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  compilationId: string;
  idempotencyKey: string;
  error?: string;
}
export class PrintQueue {
  private active = new Set<string>();
  private tasks = new Set<Promise<void>>();
  private stopped = false;
  constructor(
    private store: Storage,
    private beforeSend?: (printer: any) => Promise<void>,
    private storageFailure?: () => void,
  ) {}
  async recover() {
    for (const job of await this.store.jobsInState("sending"))
      await this.update(
        job,
        "outcome-unknown",
        "Server restarted during transmission",
      );
  }
  private async update(job: PrintJob, state: JobState, error?: string) {
    Object.assign(job, { state, error, updatedAt: new Date().toISOString() });
    await this.store.put("job", job.id, job);
  }
  async start() {
    for (const printerId of await this.store.queuedPrinterIds())
      this.kick(printerId);
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled(this.tasks);
  }
  kick(printerId: string) {
    this.store.afterCommit(() => this.launch(printerId));
  }
  private launch(printerId: string) {
    if (this.stopped || this.active.has(printerId)) return;
    this.active.add(printerId);
    const task = this.run(printerId)
      .catch(() => {
        // A storage outage stops this worker. Durable sending jobs remain uncertain;
        // they are recovered on restart, never automatically transmitted again.
        this.stopped = true;
        this.storageFailure?.();
      })
      .finally(() => {
        this.active.delete(printerId);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }
  private async run(printerId: string) {
    while (!this.stopped) {
      const job = await this.store.transaction(async () => {
        const next = (await this.store.nextQueuedJob(printerId)) as
          PrintJob | undefined;
        if (next) await this.update(next, "sending");
        return next;
      });
      if (!job) return;
      let transmitted = false;
      try {
        await this.beforeSend?.(job.printer);
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection({
            host: job.printer.host,
            port: job.printer.port ?? 9100,
          });
          let settled = false;
          const done = (error?: Error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            error ? reject(error) : resolve();
          };
          socket.setTimeout(15000, () =>
            done(new Error("Printer connection timed out")),
          );
          socket.once("error", done);
          socket.once("connect", () => {
            transmitted = true;
            socket.end(Buffer.from(job.zpl, "utf8"));
          });
          // Finish means all bytes were handed to TCP, never physical print acknowledgement.
          socket.once("finish", () => done());
          socket.once("close", () => {
            if (!settled) done(new Error("Printer connection closed"));
          });
        });
        await this.update(job, "sent");
      } catch (error) {
        await this.update(
          job,
          transmitted ? "outcome-unknown" : "failed",
          String((error as Error).message),
        );
      }
    }
  }
  async cancel(id: string) {
    return this.store.transaction(async () => {
      const job = await this.store.get<PrintJob>("job", id);
      if (!job)
        throw Object.assign(new Error("Job not found"), { statusCode: 404 });
      if (job.state !== "queued")
        throw Object.assign(new Error("Only queued jobs can be cancelled"), {
          statusCode: 409,
        });
      await this.update(job, "cancelled");
      return job;
    });
  }
}
