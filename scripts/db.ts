import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "db", "leads.db");

export interface Lead {
  id: string;
  name: string;
  headline: string | null;
  company: string | null;
  profile_url: string;
  post_content: string | null;
  post_url: string | null;
  keyword_match: string | null;
  tier: number;
  relevance: number;
  urgency: string;
  draft_message: string | null;
  status: string;
  found_at: string;
  updated_at: string;
}

export interface Run {
  id: number;
  started_at: string;
  completed_at: string | null;
  searches_run: number;
  leads_found: number;
  leads_new: number;
}

export function hashProfileUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function getDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initDb(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      headline      TEXT,
      company       TEXT,
      profile_url   TEXT UNIQUE,
      post_content  TEXT,
      post_url      TEXT,
      keyword_match TEXT,
      tier          INTEGER NOT NULL DEFAULT 1,
      relevance     REAL NOT NULL DEFAULT 0.0,
      urgency       TEXT NOT NULL DEFAULT 'low',
      draft_message TEXT,
      status        TEXT NOT NULL DEFAULT 'new',
      found_at      TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      searches_run  INTEGER NOT NULL DEFAULT 0,
      leads_found   INTEGER NOT NULL DEFAULT 0,
      leads_new     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_tier ON leads(tier);
    CREATE INDEX IF NOT EXISTS idx_leads_urgency ON leads(urgency);
    CREATE INDEX IF NOT EXISTS idx_leads_found_at ON leads(found_at);
  `);

  db.close();
  console.log(`Database initialized at ${DB_PATH}`);
}

export function upsertLead(lead: Omit<Lead, "id" | "status" | "updated_at">): {
  isNew: boolean;
} {
  const db = getDb();
  const id = hashProfileUrl(lead.profile_url);
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM leads WHERE id = ?")
    .get(id) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE leads SET
        post_content = COALESCE(?, post_content),
        post_url = COALESCE(?, post_url),
        keyword_match = COALESCE(?, keyword_match),
        tier = ?,
        relevance = MAX(relevance, ?),
        urgency = ?,
        draft_message = COALESCE(?, draft_message),
        updated_at = ?
      WHERE id = ?`
    ).run(
      lead.post_content,
      lead.post_url,
      lead.keyword_match,
      lead.tier,
      lead.relevance,
      lead.urgency,
      lead.draft_message,
      now,
      id
    );
    db.close();
    return { isNew: false };
  }

  db.prepare(
    `INSERT INTO leads (id, name, headline, company, profile_url, post_content, post_url, keyword_match, tier, relevance, urgency, draft_message, status, found_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
  ).run(
    id,
    lead.name,
    lead.headline,
    lead.company,
    lead.profile_url,
    lead.post_content,
    lead.post_url,
    lead.keyword_match,
    lead.tier,
    lead.relevance,
    lead.urgency,
    lead.draft_message,
    lead.found_at,
    now
  );

  db.close();
  return { isNew: true };
}

export function getLeads(filters: {
  status?: string;
  tier?: number;
  urgency?: string;
  limit?: number;
  offset?: number;
}): Lead[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.tier) {
    conditions.push("tier = ?");
    params.push(filters.tier);
  }
  if (filters.urgency) {
    conditions.push("urgency = ?");
    params.push(filters.urgency);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  const rows = db
    .prepare(
      `SELECT * FROM leads ${where} ORDER BY relevance DESC, found_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Lead[];

  db.close();
  return rows;
}

export function getLeadById(id: string): Lead | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as
    | Lead
    | undefined;
  db.close();
  return row;
}

export function updateLeadStatus(id: string, status: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now, id);
  db.close();
  return result.changes > 0;
}

export function logRunStart(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO runs (started_at, searches_run, leads_found, leads_new) VALUES (?, 0, 0, 0)")
    .run(now);
  db.close();
  return Number(result.lastInsertRowid);
}

export function logRunEnd(
  runId: number,
  stats: { searches_run: number; leads_found: number; leads_new: number }
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE runs SET completed_at = ?, searches_run = ?, leads_found = ?, leads_new = ? WHERE id = ?"
  ).run(now, stats.searches_run, stats.leads_found, stats.leads_new, runId);
  db.close();
}

export function getStats(): {
  total_leads: number;
  new_leads: number;
  contacted: number;
  replied: number;
  archived: number;
  by_tier: { tier: number; count: number }[];
  by_urgency: { urgency: string; count: number }[];
  recent_runs: Run[];
  today_new: number;
} {
  const db = getDb();

  const total = db.prepare("SELECT COUNT(*) as c FROM leads").get() as { c: number };
  const byStatus = db
    .prepare("SELECT status, COUNT(*) as c FROM leads GROUP BY status")
    .all() as { status: string; c: number }[];
  const byTier = db
    .prepare("SELECT tier, COUNT(*) as count FROM leads GROUP BY tier ORDER BY tier")
    .all() as { tier: number; count: number }[];
  const byUrgency = db
    .prepare("SELECT urgency, COUNT(*) as count FROM leads GROUP BY urgency")
    .all() as { urgency: string; count: number }[];
  const recentRuns = db
    .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 10")
    .all() as Run[];

  const today = new Date().toISOString().split("T")[0];
  const todayNew = db
    .prepare("SELECT COUNT(*) as c FROM leads WHERE found_at >= ?")
    .get(today) as { c: number };

  const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, r.c]));

  db.close();

  return {
    total_leads: total.c,
    new_leads: statusMap["new"] || 0,
    contacted: statusMap["contacted"] || 0,
    replied: statusMap["replied"] || 0,
    archived: statusMap["archived"] || 0,
    by_tier: byTier,
    by_urgency: byUrgency,
    recent_runs: recentRuns,
    today_new: todayNew.c,
  };
}

export function getTodayLeads(): Lead[] {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const rows = db
    .prepare(
      "SELECT * FROM leads WHERE found_at >= ? ORDER BY relevance DESC"
    )
    .all(today) as Lead[];
  db.close();
  return rows;
}

// CLI interface — only run when executed directly
const isMain = process.argv[1]?.includes("db");
const command = isMain ? process.argv[2] : undefined;

if (command === "init") {
  initDb();
} else if (command === "stats") {
  const stats = getStats();
  console.log(JSON.stringify(stats, null, 2));
} else if (command === "upsert") {
  const input = process.argv[3];
  if (!input) {
    console.error("Usage: db.ts upsert '<json array of leads>'");
    process.exit(1);
  }
  const leads = JSON.parse(input);
  let newCount = 0;
  for (const lead of leads) {
    const { isNew } = upsertLead(lead);
    if (isNew) newCount++;
  }
  console.log(JSON.stringify({ total: leads.length, new: newCount }));
} else if (command === "today") {
  const leads = getTodayLeads();
  console.log(JSON.stringify(leads, null, 2));
} else if (command) {
  console.error(`Unknown command: ${command}`);
  console.error("Available: init, stats, upsert, today");
  process.exit(1);
}
