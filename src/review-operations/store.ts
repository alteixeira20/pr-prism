import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { batches, type Evidence, fingerprint, hash, type Kind, type State } from "./contracts.js";

export interface Job {
  id: string;
  repo: string;
  kind: Kind;
  number: number;
  fingerprint: string;
  evidence: string;
  state: State;
  reason: string | null;
  owner: string | null;
  expires: number | null;
}
export class OperationsStore {
  readonly db: Database.Database;
  constructor(file: string, readonly = false) {
    if (!readonly) mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { readonly, fileMustExist: readonly, timeout: 1000 });
    if (!readonly) {
      // A dedicated database avoids migrations or reinterpretation of the V4 ledger.
      const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      if (existing.length && !existing.some((t) => t.name === "v5_jobs")) {
        this.db.close();
        throw new Error("Refusing non-V5 database; offline migration required");
      }
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS v5_jobs(id TEXT PRIMARY KEY, repo TEXT, kind TEXT, number INTEGER, fingerprint TEXT, evidence TEXT, state TEXT, reason TEXT, owner TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS v5_current(repo TEXT,kind TEXT,number INTEGER,id TEXT,PRIMARY KEY(repo,kind,number));
        CREATE TABLE IF NOT EXISTS v5_runs(id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS v5_attempts(id TEXT PRIMARY KEY, run TEXT, job TEXT, account TEXT, model TEXT, batch INTEGER, batch_hash TEXT, state TEXT, result TEXT, started INTEGER, finished INTEGER, latency REAL, spend REAL);
        CREATE TABLE IF NOT EXISTS v5_leases(account TEXT PRIMARY KEY, owner TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS v5_sync(repo TEXT, kind TEXT, value TEXT, PRIMARY KEY(repo,kind));
        CREATE TABLE IF NOT EXISTS v5_events(id INTEGER PRIMARY KEY, job TEXT, kind TEXT, observed INTEGER, value TEXT);
        PRAGMA user_version=5;`);
    }
  }
  close() {
    this.db.close();
  }
  jobs(repo: string, kind: Kind): Job[] {
    return this.db.prepare("SELECT * FROM v5_jobs WHERE repo=? AND kind=? ORDER BY number,id").all(repo, kind) as Job[];
  }
  event(job: string, kind: string, value: unknown) {
    this.db
      .prepare("INSERT INTO v5_events(job,kind,observed,value) VALUES(?,?,?,?)")
      .run(job, kind, Date.now(), JSON.stringify(value));
  }
  put(e: Evidence) {
    const fp = fingerprint(e);
    const id = hash([e.repo, e.kind, e.number, fp]);
    this.db
      .transaction(() => {
        const previous = this.jobs(e.repo, e.kind).filter(
          (j) =>
            j.number === e.number && j.fingerprint !== fp && j.state !== "stale" && j.state !== "externally_resolved",
        );
        for (const j of previous) {
          this.set(
            j.id,
            e.state === "open" ? "stale" : "externally_resolved",
            e.state === "open" ? "evidence_changed" : e.state,
          );
        }
        this.db
          .prepare("INSERT OR IGNORE INTO v5_jobs VALUES(?,?,?,?,?,?,?,?,NULL,NULL)")
          .run(
            id,
            e.repo,
            e.kind,
            e.number,
            fp,
            JSON.stringify(e),
            e.state === "open" ? "pending" : "externally_resolved",
            e.state === "open" ? null : e.state,
          );
        this.db.prepare("INSERT OR REPLACE INTO v5_current VALUES(?,?,?,?)").run(e.repo, e.kind, e.number, id);
        this.db
          .prepare(
            "UPDATE v5_jobs SET state='pending',reason='reopened' WHERE id=? AND state IN ('stale','externally_resolved') AND ?='open'",
          )
          .run(id, e.state);
        this.event(id, "remote_observation", e);
        for (const event of e.events as any[]) {
          const type =
            event.state === "APPROVED"
              ? "approved_elsewhere"
              : event.state === "CHANGES_REQUESTED"
                ? "changes_requested_elsewhere"
                : event.event;
          if (type)
            this.event(id, type, {
              who: event.user?.login ?? event.actor?.login,
              when: event.submitted_at ?? event.created_at,
              observedAt: e.observedAt,
            });
        }
      })
      .immediate();
    return id;
  }
  set(id: string, state: State, reason: string | null = null) {
    this.db.prepare("UPDATE v5_jobs SET state=?,reason=? WHERE id=?").run(state, reason, id);
    this.event(id, state, { reason });
  }
  sync(repo: string, kind: Kind, value: any) {
    const old = this.db.prepare("SELECT value FROM v5_sync WHERE repo=? AND kind=?").get(repo, kind) as
      | { value: string }
      | undefined;
    value = {
      ...value,
      lastReliableSync: value.reliable ? value.completed : old ? JSON.parse(old.value).lastReliableSync : null,
    };
    this.db.prepare("INSERT OR REPLACE INTO v5_sync VALUES(?,?,?)").run(repo, kind, JSON.stringify(value));
  }
  startRun(id: string, budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("max-new-calls must be a nonnegative integer");
    this.db.prepare("INSERT OR IGNORE INTO v5_runs(id,budget,state) VALUES(?,?,'running')").run(id, budget);
    const run = this.db.prepare("SELECT * FROM v5_runs WHERE id=?").get(id) as { budget: number };
    if (run.budget !== budget) throw new Error("Resumed run budget must match original budget");
  }
  claim(repo: string, kind: Kind, owner: string): Job | undefined {
    return this.db
      .transaction(() => {
        const now = Date.now();
        // Crash uncertainty is kept in the attempt ledger and never silently retried.
        const expired = this.db
          .prepare("SELECT * FROM v5_jobs WHERE repo=? AND kind=? AND owner IS NOT NULL AND expires<?")
          .all(repo, kind, now) as Job[];
        for (const j of expired) {
          this.set(j.id, "paused", "expired_worker_requires_operator_recovery");
          this.db.prepare("UPDATE v5_jobs SET owner=NULL,expires=NULL WHERE id=?").run(j.id);
        }
        const job = this.db
          .prepare(
            "SELECT * FROM v5_jobs WHERE repo=? AND kind=? AND (state='pending' OR (state='partial' AND reason IN ('budget_stop','account_or_worker_busy'))) AND owner IS NULL AND id IN (SELECT id FROM v5_current WHERE repo=v5_jobs.repo AND kind=v5_jobs.kind) ORDER BY number,id LIMIT 1",
          )
          .get(repo, kind) as Job | undefined;
        if (job)
          this.db
            .prepare("UPDATE v5_jobs SET owner=?,expires=?,state='active' WHERE id=?")
            .run(owner, now + 60000, job.id);
        return job;
      })
      .immediate();
  }
  heartbeat(owner: string) {
    this.db.prepare("UPDATE v5_jobs SET expires=? WHERE owner=?").run(Date.now() + 60000, owner);
    this.db.prepare("UPDATE v5_leases SET expires=? WHERE owner=?").run(Date.now() + 60000, owner);
  }
  release(job: string, owner: string) {
    this.db.prepare("UPDATE v5_jobs SET owner=NULL,expires=NULL WHERE id=? AND owner=?").run(job, owner);
    this.db.prepare("DELETE FROM v5_leases WHERE owner=?").run(owner);
  }
  reserve(
    run: string,
    job: Job,
    account: string,
    model: string,
    batch: number,
    batchHash: string,
    owner: string,
    cap: number,
  ): string | undefined {
    return this.db
      .transaction(() => {
        const now = Date.now();
        this.db.prepare("DELETE FROM v5_leases WHERE expires<?").run(now);
        const count = this.db.prepare("SELECT COUNT(*) n FROM v5_leases").get() as { n: number };
        if (count.n >= cap || this.db.prepare("SELECT 1 FROM v5_leases WHERE account=?").get(account)) return undefined;
        if (!this.db.prepare("UPDATE v5_runs SET spent=spent+1 WHERE id=? AND spent<budget").run(run).changes)
          return undefined;
        const id = randomUUID();
        this.db.prepare("INSERT INTO v5_leases VALUES(?,?,?)").run(account, owner, now + 60000);
        this.db
          .prepare(
            "INSERT INTO v5_attempts(id,run,job,account,model,batch,batch_hash,state,started) VALUES(?,?,?,?,?,?,?,'attempted',?)",
          )
          .run(id, run, job.id, account, model, batch, batchHash, now);
        return id;
      })
      .immediate();
  }
  finish(id: string, state: string, result: unknown, latency?: number, spend?: number) {
    this.db
      .prepare("UPDATE v5_attempts SET state=?,result=?,finished=?,latency=?,spend=? WHERE id=? AND state='attempted'")
      .run(state, JSON.stringify(result), Date.now(), latency ?? null, spend ?? null, id);
  }
  checkpoint(job: string, model: string, batchHash: string) {
    return this.db
      .prepare(
        "SELECT * FROM v5_attempts WHERE job=? AND model=? AND batch_hash=? AND state='completed' ORDER BY started LIMIT 1",
      )
      .get(job, model, batchHash);
  }
  snapshot(repo: string, kind: Kind) {
    return this.db.transaction(() => this.snapshotData(repo, kind)).deferred();
  }
  private snapshotData(repo: string, kind: Kind) {
    const jobs = this.jobs(repo, kind);
    const currentIds = new Set(
      (this.db.prepare("SELECT id FROM v5_current WHERE repo=? AND kind=?").all(repo, kind) as { id: string }[]).map(
        (j) => j.id,
      ),
    );
    const current = jobs.filter((j) => currentIds.has(j.id));
    const counts: Record<string, number> = {};
    for (const j of current) counts[j.state] = (counts[j.state] ?? 0) + 1;
    const attempts = this.db
      .prepare(
        "SELECT a.* FROM v5_attempts a JOIN v5_jobs j ON j.id=a.job WHERE j.repo=? AND j.kind=? ORDER BY started DESC",
      )
      .all(repo, kind) as any[];
    const known = current.filter((j) => ["pending", "partial", "active"].includes(j.state));
    const minimumBatches = known.reduce(
      (n, j) =>
        n +
        batches(JSON.parse(j.evidence)).filter(
          (b) => !attempts.some((a) => a.job === j.id && a.batch_hash === b.hash && a.state === "completed"),
        ).length,
      0,
    );
    const historicalStale = jobs.filter((j) => j.state === "stale").length;
    const timings = attempts.filter((a) => a.state === "completed" && a.latency > 0);
    const perBatch = timings.length >= 3 ? timings.reduce((n, a) => n + a.latency, 0) / timings.length / 1000 : null;
    const runs = this.db.prepare("SELECT * FROM v5_runs").all() as any[];
    const sync = this.db.prepare("SELECT value FROM v5_sync WHERE repo=? AND kind=?").get(repo, kind) as
      | { value: string }
      | undefined;
    return {
      repo,
      type: kind,
      historicalStale,
      totalOpen: current.filter((j) => JSON.parse(j.evidence).state === "open").length,
      counts,
      eligible: known.length,
      skipped: counts.completed_current ?? 0,
      externallyHandled: counts.externally_resolved ?? 0,
      inProgress: counts.active ?? 0,
      blocked: counts.blocked ?? 0,
      estimatedMinimumEvidenceBatches: minimumBatches,
      active: current.filter((j) => j.owner).map((j) => ({ number: j.number, expires: j.expires, state: j.state })),
      workers: this.db.prepare("SELECT account,expires FROM v5_leases").all(),
      runs,
      rateLimit: current.map((j) => JSON.parse(j.evidence)).find((e) => e.health)?.health ?? null,
      recentEvents: this.db
        .prepare(
          "SELECT e.kind,e.observed,e.value FROM v5_events e JOIN v5_jobs j ON e.job=j.id WHERE j.repo=? AND j.kind=? AND e.kind!='remote_observation' ORDER BY e.id DESC LIMIT 10",
        )
        .all(repo, kind),
      perModel: this.db
        .prepare(
          "SELECT a.model,COUNT(*) attempts,SUM(a.latency) latencyMs,SUM(a.spend) reportedSpend FROM v5_attempts a JOIN v5_jobs j ON a.job=j.id WHERE j.repo=? AND j.kind=? GROUP BY a.model",
        )
        .all(repo, kind),
      attempts: attempts.map(({ result: _result, ...a }) => a),
      latestCheckpoints: attempts
        .filter((a) => a.state === "completed")
        .slice(0, 5)
        .map((a) => ({ job: a.job, batch: a.batch, finished: a.finished })),
      sync: sync ? JSON.parse(sync.value) : null,
      eta: {
        estimated: true,
        boundedStopSeconds:
          perBatch === null
            ? null
            : perBatch *
              Math.min(
                minimumBatches,
                runs.reduce((n, r) => n + Math.max(0, r.budget - r.spent), 0),
              ),
        backlogSeconds: perBatch === null ? null : perBatch * minimumBatches,
        basis: "observed completed batch latency; serial estimate; excludes unavailable evidence and future changes",
      },
    };
  }
}
