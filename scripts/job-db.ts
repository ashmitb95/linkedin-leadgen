/**
 * job-db.ts — SQLite database layer for job search pipeline.
 *
 * Supports multiple profiles via createJobStore(dbPath).
 * Default exports use db/jobs.db for backward compatibility.
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Job {
  id: string;
  dedup_key: string;
  source: string;
  title: string;
  company: string;
  location: string;
  work_mode: string;
  salary_range: string | null;
  job_url: string;
  apply_url: string;
  job_description: string;
  recruiter_name: string;
  recruiter_email: string;
  recruiter_url: string;
  poster_name: string;
  poster_headline: string;
  poster_url: string;
  post_content: string;
  post_url: string;
  fit_score: number;
  stack_match: number;
  seniority_match: string;
  urgency: string;
  reasoning: string;
  draft_message: string;
  keyword_match: string;
  status: string;
  notes: string;
  found_at: string;
  updated_at: string;
}

export interface JobStore {
  getDb(): Database.Database;
  initDb(): void;
  upsertJob(job: UpsertJobInput): { isNew: boolean };
  getJobs(filters: JobFilters): Job[];
  getJobById(id: string): Job | undefined;
  updateJobStatus(id: string, status: string): boolean;
  updateJobNotes(id: string, notes: string): boolean;
  logJobRunStart(): number;
  logJobRunEnd(runId: number, stats: { searches_run: number; jobs_found: number; jobs_new: number }): void;
  getJobStats(): any;
  getTodayJobs(): Job[];
}

export interface UpsertJobInput {
  dedup_key: string;
  source: string;
  title: string;
  company: string;
  location: string;
  work_mode: string;
  salary_range?: string | null;
  job_url: string;
  apply_url?: string;
  job_description: string;
  recruiter_name?: string;
  recruiter_email?: string;
  recruiter_url?: string;
  poster_name?: string;
  poster_headline?: string;
  poster_url?: string;
  post_content?: string;
  post_url?: string;
  fit_score: number;
  stack_match: number;
  seniority_match: string;
  urgency: string;
  reasoning?: string;
  draft_message?: string;
  keyword_match: string;
  found_at: string;
}

export interface JobFilters {
  status?: string;
  work_mode?: string;
  urgency?: string;
  min_fit?: number;
  limit?: number;
  offset?: number;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// ───── Factory ─────

export function createJobStore(dbPath: string): JobStore {
  function getDb(): Database.Database {
    const db = new Database(dbPath, { fileMustExist: false });
    db.pragma("journal_mode = WAL");
    return db;
  }

  function initDb(): void {
    const db = getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id              TEXT PRIMARY KEY,
        dedup_key       TEXT UNIQUE NOT NULL,
        source          TEXT NOT NULL DEFAULT 'content',

        title           TEXT NOT NULL DEFAULT '',
        company         TEXT DEFAULT '',
        location        TEXT DEFAULT '',
        work_mode       TEXT NOT NULL DEFAULT 'unknown',
        salary_range    TEXT,
        job_url         TEXT DEFAULT '',
        apply_url       TEXT DEFAULT '',
        job_description TEXT DEFAULT '',

        recruiter_name  TEXT DEFAULT '',
        recruiter_email TEXT DEFAULT '',
        recruiter_url   TEXT DEFAULT '',

        poster_name     TEXT DEFAULT '',
        poster_headline TEXT DEFAULT '',
        poster_url      TEXT DEFAULT '',
        post_content    TEXT DEFAULT '',
        post_url        TEXT DEFAULT '',

        fit_score       REAL NOT NULL DEFAULT 0.0,
        stack_match     REAL NOT NULL DEFAULT 0.0,
        seniority_match TEXT NOT NULL DEFAULT 'unknown',
        urgency         TEXT NOT NULL DEFAULT 'low',
        reasoning       TEXT DEFAULT '',
        draft_message   TEXT DEFAULT '',

        keyword_match   TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'new',
        notes           TEXT DEFAULT '',
        found_at        TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        searches_run    INTEGER NOT NULL DEFAULT 0,
        jobs_found      INTEGER NOT NULL DEFAULT 0,
        jobs_new        INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_fit_score ON jobs(fit_score);
      CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
      CREATE INDEX IF NOT EXISTS idx_jobs_found_at ON jobs(found_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_work_mode ON jobs(work_mode);
    `);

    // Migrate existing DB — add new columns if missing
    const cols = db.prepare("PRAGMA table_info(jobs)").all() as any[];
    const colNames = new Set(cols.map((c: any) => c.name));
    if (!colNames.has("apply_url")) db.exec("ALTER TABLE jobs ADD COLUMN apply_url TEXT DEFAULT ''");
    if (!colNames.has("recruiter_name")) db.exec("ALTER TABLE jobs ADD COLUMN recruiter_name TEXT DEFAULT ''");
    if (!colNames.has("recruiter_email")) db.exec("ALTER TABLE jobs ADD COLUMN recruiter_email TEXT DEFAULT ''");
    if (!colNames.has("recruiter_url")) db.exec("ALTER TABLE jobs ADD COLUMN recruiter_url TEXT DEFAULT ''");

    db.close();
    console.log(`Database initialized at ${dbPath}`);
  }

  function upsertJob(job: UpsertJobInput): { isNew: boolean } {
    const db = getDb();
    const id = hashKey(job.dedup_key);
    const now = new Date().toISOString();

    const existing = db.prepare("SELECT id FROM jobs WHERE id = ?").get(id);

    if (existing) {
      db.prepare(`
        UPDATE jobs SET
          title = COALESCE(?, title),
          company = COALESCE(?, company),
          location = COALESCE(?, location),
          work_mode = ?,
          salary_range = COALESCE(?, salary_range),
          job_url = COALESCE(?, job_url),
          apply_url = COALESCE(?, apply_url),
          job_description = COALESCE(?, job_description),
          recruiter_name = COALESCE(?, recruiter_name),
          recruiter_email = COALESCE(?, recruiter_email),
          recruiter_url = COALESCE(?, recruiter_url),
          poster_name = COALESCE(?, poster_name),
          poster_headline = COALESCE(?, poster_headline),
          poster_url = COALESCE(?, poster_url),
          post_content = COALESCE(?, post_content),
          post_url = COALESCE(?, post_url),
          fit_score = MAX(fit_score, ?),
          stack_match = MAX(stack_match, ?),
          seniority_match = ?,
          urgency = ?,
          reasoning = COALESCE(?, reasoning),
          draft_message = COALESCE(?, draft_message),
          keyword_match = COALESCE(?, keyword_match),
          updated_at = ?
        WHERE id = ?
      `).run(
        job.title || null, job.company || null, job.location || null,
        job.work_mode,
        job.salary_range || null, job.job_url || null, job.apply_url || null,
        job.job_description || null,
        job.recruiter_name || null, job.recruiter_email || null, job.recruiter_url || null,
        job.poster_name || null, job.poster_headline || null, job.poster_url || null,
        job.post_content || null, job.post_url || null,
        job.fit_score, job.stack_match,
        job.seniority_match, job.urgency,
        job.reasoning || null, job.draft_message || null,
        job.keyword_match || null,
        now, id
      );
      db.close();
      return { isNew: false };
    }

    db.prepare(`
      INSERT INTO jobs (
        id, dedup_key, source,
        title, company, location, work_mode, salary_range, job_url, apply_url, job_description,
        recruiter_name, recruiter_email, recruiter_url,
        poster_name, poster_headline, poster_url, post_content, post_url,
        fit_score, stack_match, seniority_match, urgency, reasoning, draft_message,
        keyword_match, status, notes, found_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '', ?, ?)
    `).run(
      id, job.dedup_key, job.source,
      job.title, job.company || "", job.location || "", job.work_mode, job.salary_range || null,
      job.job_url || "", job.apply_url || "", job.job_description || "",
      job.recruiter_name || "", job.recruiter_email || "", job.recruiter_url || "",
      job.poster_name || "", job.poster_headline || "", job.poster_url || "",
      job.post_content || "", job.post_url || "",
      job.fit_score, job.stack_match, job.seniority_match, job.urgency,
      job.reasoning || "", job.draft_message || "",
      job.keyword_match || "",
      job.found_at, now
    );

    db.close();
    return { isNew: true };
  }

  function getJobs(filters: JobFilters): Job[] {
    const db = getDb();
    const clauses: string[] = [];
    const params: any[] = [];

    if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
    if (filters.work_mode) { clauses.push("work_mode = ?"); params.push(filters.work_mode); }
    if (filters.urgency) { clauses.push("urgency = ?"); params.push(filters.urgency); }
    if (filters.min_fit) { clauses.push("fit_score >= ?"); params.push(filters.min_fit); }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const jobs = db.prepare(
      `SELECT * FROM jobs ${where} ORDER BY fit_score DESC, found_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Job[];

    db.close();
    return jobs;
  }

  function getJobById(id: string): Job | undefined {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
    db.close();
    return job;
  }

  function updateJobStatus(id: string, status: string): boolean {
    const db = getDb();
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    db.close();
    return result.changes > 0;
  }

  function updateJobNotes(id: string, notes: string): boolean {
    const db = getDb();
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE jobs SET notes = ?, updated_at = ? WHERE id = ?").run(notes, now, id);
    db.close();
    return result.changes > 0;
  }

  function logJobRunStart(): number {
    const db = getDb();
    const now = new Date().toISOString();
    const result = db.prepare("INSERT INTO job_runs (started_at) VALUES (?)").run(now);
    db.close();
    return result.lastInsertRowid as number;
  }

  function logJobRunEnd(
    runId: number,
    stats: { searches_run: number; jobs_found: number; jobs_new: number }
  ): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE job_runs SET completed_at = ?, searches_run = ?, jobs_found = ?, jobs_new = ? WHERE id = ?"
    ).run(now, stats.searches_run, stats.jobs_found, stats.jobs_new, runId);
    db.close();
  }

  function getJobStats(): any {
    const db = getDb();

    const total = db.prepare("SELECT COUNT(*) as c FROM jobs").get() as any;
    const byStatus = db.prepare(
      "SELECT status, COUNT(*) as count FROM jobs GROUP BY status"
    ).all() as any[];
    const byWorkMode = db.prepare(
      "SELECT work_mode, COUNT(*) as count FROM jobs GROUP BY work_mode"
    ).all() as any[];
    const bySeniority = db.prepare(
      "SELECT seniority_match, COUNT(*) as count FROM jobs GROUP BY seniority_match"
    ).all() as any[];
    const recentRuns = db.prepare(
      "SELECT * FROM job_runs ORDER BY id DESC LIMIT 10"
    ).all() as any[];

    const today = new Date().toISOString().slice(0, 10);
    const todayNew = db.prepare(
      "SELECT COUNT(*) as c FROM jobs WHERE found_at >= ? AND found_at < ?"
    ).get(today + "T00:00:00", today + "T23:59:59") as any;

    const statusMap: Record<string, number> = {};
    for (const s of byStatus) statusMap[s.status] = s.count;

    db.close();

    return {
      total_jobs: total.c,
      new_jobs: statusMap["new"] || 0,
      saved: statusMap["saved"] || 0,
      applied: statusMap["applied"] || 0,
      interviewing: statusMap["interviewing"] || 0,
      offer: statusMap["offer"] || 0,
      rejected: statusMap["rejected"] || 0,
      archived: statusMap["archived"] || 0,
      by_work_mode: byWorkMode,
      by_seniority: bySeniority,
      recent_runs: recentRuns,
      today_new: todayNew.c,
    };
  }

  function getTodayJobs(): Job[] {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const jobs = db.prepare(
      "SELECT * FROM jobs WHERE found_at >= ? ORDER BY fit_score DESC"
    ).all(today + "T00:00:00") as Job[];
    db.close();
    return jobs;
  }

  return {
    getDb, initDb, upsertJob, getJobs, getJobById,
    updateJobStatus, updateJobNotes,
    logJobRunStart, logJobRunEnd, getJobStats, getTodayJobs,
  };
}

// ───── Default store (backward-compatible exports) ─────

const DEFAULT_DB_PATH = path.join(__dirname, "..", "db", "jobs.db");
const defaultStore = createJobStore(DEFAULT_DB_PATH);

export const getDb = defaultStore.getDb;
export const initDb = defaultStore.initDb;
export const upsertJob = defaultStore.upsertJob;
export const getJobs = defaultStore.getJobs;
export const getJobById = defaultStore.getJobById;
export const updateJobStatus = defaultStore.updateJobStatus;
export const updateJobNotes = defaultStore.updateJobNotes;
export const logJobRunStart = defaultStore.logJobRunStart;
export const logJobRunEnd = defaultStore.logJobRunEnd;
export const getJobStats = defaultStore.getJobStats;
export const getTodayJobs = defaultStore.getTodayJobs;

const isMain = process.argv[1]?.includes("job-db");
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "init") {
    initDb();
  } else if (cmd === "stats") {
    initDb();
    console.log(JSON.stringify(getJobStats(), null, 2));
  } else {
    console.log("Usage: npx tsx scripts/job-db.ts [init|stats]");
  }
}
