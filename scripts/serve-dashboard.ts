/**
 * serve-dashboard.ts — Hono API server + static dashboard for lead management.
 *
 * Endpoints:
 *   GET  /api/leads?status=new&tier=3&urgency=high
 *   GET  /api/leads/:id
 *   PATCH /api/leads/:id  { status: "contacted" }
 *   GET  /api/stats
 *   GET  /api/runs
 *   GET  /api/digest?date=2026-02-27
 *   GET  /                (dashboard UI)
 *
 * Usage:
 *   npx tsx scripts/serve-dashboard.ts
 *   npm run dashboard
 *   npm run dev  (with --watch)
 */

import { loadEnv } from "./env.js";
loadEnv();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  getLeads,
  getLeadById,
  updateLeadStatus,
  getStats,
  getDb,
} from "./db.js";
import { generateDigest } from "./digest.js";
import {
  initDb as initJobDb,
  getJobs,
  getJobById,
  updateJobStatus,
  updateJobNotes,
  getJobStats,
} from "./job-db.js";
import { generateJobDigest } from "./job-digest.js";
import { createJobStore } from "./job-db.js";
import { generateAnushaJobDigest } from "./anusha-job-digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Anusha's separate job store
const anushaStore = createJobStore(path.join(ROOT, "db", "anusha-jobs.db"));

// Ensure DBs exist
initDb();
initJobDb();
anushaStore.initDb();

const app = new Hono();

app.use("*", cors());

// API routes
app.get("/api/leads", (c) => {
  const status = c.req.query("status") || undefined;
  const tier = c.req.query("tier") ? Number(c.req.query("tier")) : undefined;
  const urgency = c.req.query("urgency") || undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;

  const leads = getLeads({ status, tier, urgency, limit, offset });
  return c.json({ leads, count: leads.length });
});

app.get("/api/leads/:id", (c) => {
  const lead = getLeadById(c.req.param("id"));
  if (!lead) return c.json({ error: "Lead not found" }, 404);
  return c.json(lead);
});

app.patch("/api/leads/:id", async (c) => {
  const body = await c.req.json();
  const validStatuses = ["new", "contacted", "replied", "archived"];

  if (!body.status || !validStatuses.includes(body.status)) {
    return c.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      400
    );
  }

  const updated = updateLeadStatus(c.req.param("id"), body.status);
  if (!updated) return c.json({ error: "Lead not found" }, 404);
  return c.json({ success: true });
});

app.get("/api/stats", (c) => {
  return c.json(getStats());
});

app.get("/api/runs", (c) => {
  const db = getDb();
  const runs = db
    .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 20")
    .all();
  db.close();
  return c.json({ runs });
});

app.get("/api/digest", (c) => {
  const date = c.req.query("date") || undefined;
  const digest = generateDigest(date);
  return c.json({ digest });
});

// ───── Export endpoints ─────

app.get("/api/export/csv", (c) => {
  const status = c.req.query("status") || undefined;
  const tier = c.req.query("tier") ? Number(c.req.query("tier")) : undefined;
  const urgency = c.req.query("urgency") || undefined;
  const leads = getLeads({ status, tier, urgency, limit: 1000, offset: 0 });

  const csvEsc = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
  const header = "Name,Company,Headline,Tier,Relevance,Urgency,Status,Post,Draft Message,Profile URL,Found";
  const rows = leads.map((l: any) =>
    [
      csvEsc(l.name),
      csvEsc(l.company),
      csvEsc(l.headline),
      l.tier === 1 ? "T1 Freelance" : l.tier === 2 ? "T2 Product" : l.tier === 3 ? "T3 AI Scale" : "T4 Branding",
      Math.round(l.relevance * 100) + "%",
      l.urgency,
      l.status,
      csvEsc(l.post_content),
      csvEsc(l.draft_message),
      l.profile_url,
      l.found_at ? new Date(l.found_at).toLocaleDateString() : "",
    ].join(",")
  );

  const csv = [header, ...rows].join("\n");
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body(csv);
});

app.get("/api/export/html", (c) => {
  const status = c.req.query("status") || undefined;
  const tier = c.req.query("tier") ? Number(c.req.query("tier")) : undefined;
  const urgency = c.req.query("urgency") || undefined;
  const leads = getLeads({ status, tier, urgency, limit: 1000, offset: 0 });
  const stats = getStats();
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const tierLabel = (t: number) => t === 1 ? "T1 Freelance" : t === 2 ? "T2 Product" : t === 3 ? "T3 AI Scale" : "T4 Branding";
  const tierColor = (t: number) => t === 1 ? "#3b82f6" : t === 2 ? "#8b5cf6" : t === 3 ? "#f59e0b" : "#ec4899";
  const urgencyColor = (u: string) => u === "high" ? "#ef4444" : u === "medium" ? "#f59e0b" : "#6b7280";

  const leadCards = leads.map((l: any) => `
    <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1);border-left:4px solid ${tierColor(l.tier)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-size:18px;font-weight:700;color:#1a1a2e">${esc(l.name)}</div>
          <div style="font-size:14px;color:#6b7280">${esc(l.company || "")}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <span style="background:${tierColor(l.tier)};color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${tierLabel(l.tier)}</span>
          <span style="background:${urgencyColor(l.urgency)};color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${l.urgency}</span>
          <span style="background:#e5e7eb;color:#374151;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${Math.round(l.relevance * 100)}%</span>
        </div>
      </div>
      ${l.headline ? `<div style="font-size:13px;color:#4b5563;margin-bottom:10px;font-style:italic">${esc(l.headline)}</div>` : ""}
      ${l.post_content ? `
        <div style="background:#f9fafb;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#374151;line-height:1.5;border:1px solid #e5e7eb">
          <div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:4px;text-transform:uppercase">Their Post</div>
          ${esc(l.post_content)}
        </div>` : ""}
      ${l.draft_message ? `
        <div style="background:#eff6ff;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#1e40af;line-height:1.5;border:1px solid #bfdbfe">
          <div style="font-size:11px;font-weight:600;color:#60a5fa;margin-bottom:4px;text-transform:uppercase">Draft Outreach</div>
          ${esc(l.draft_message)}
        </div>` : ""}
      <div style="display:flex;gap:16px;font-size:12px;color:#9ca3af">
        ${l.profile_url ? `<a href="${esc(l.profile_url)}" style="color:#2563eb;text-decoration:none">LinkedIn Profile</a>` : ""}
        <span>Found: ${l.found_at ? new Date(l.found_at).toLocaleDateString() : "N/A"}</span>
        <span>Status: ${l.status}</span>
      </div>
    </div>`).join("");

  const highCount = leads.filter((l: any) => l.urgency === "high").length;
  const t1 = leads.filter((l: any) => l.tier === 1).length;
  const t2 = leads.filter((l: any) => l.tier === 2).length;
  const t3 = leads.filter((l: any) => l.tier === 3).length;
  const t4 = leads.filter((l: any) => l.tier === 4).length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lead Report — ${today}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:720px;margin:0 auto;padding:32px 16px">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-size:28px;font-weight:800;color:#1a1a2e;margin:0 0 4px 0">LinkedIn Lead Report</h1>
      <p style="font-size:14px;color:#6b7280;margin:0">${today}</p>
    </div>

    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:28px">
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#1a1a2e">${leads.length}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Total Leads</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#ef4444">${highCount}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">High Urgency</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#3b82f6">${t1}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">T1 Freelance</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#8b5cf6">${t2 + t3}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">T2/T3 Product</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#ec4899">${t4}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">T4 Branding</div>
      </div>
    </div>

    ${leadCards}

    <div style="text-align:center;margin-top:32px;padding:16px;font-size:12px;color:#9ca3af">
      Generated by LinkedIn Lead Gen Pipeline
    </div>
  </div>
</body>
</html>`;

  c.header("Content-Type", "text/html");
  c.header("Content-Disposition", `attachment; filename="lead-report-${new Date().toISOString().slice(0, 10)}.html"`);
  return c.body(html);
});

// ───── Job Search API ─────

app.get("/api/jobs", (c) => {
  const status = c.req.query("status") || undefined;
  const work_mode = c.req.query("work_mode") || undefined;
  const urgency = c.req.query("urgency") || undefined;
  const min_fit = c.req.query("min_fit") ? Number(c.req.query("min_fit")) : undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;

  const jobs = getJobs({ status, work_mode, urgency, min_fit, limit, offset });
  return c.json({ jobs, count: jobs.length });
});

app.get("/api/jobs/:id", (c) => {
  const job = getJobById(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

app.patch("/api/jobs/:id", async (c) => {
  const body = await c.req.json();
  const validStatuses = ["new", "saved", "applied", "interviewing", "offer", "rejected", "archived"];
  const id = c.req.param("id");

  if (body.notes !== undefined) {
    const updated = updateJobNotes(id, body.notes);
    if (!updated) return c.json({ error: "Job not found" }, 404);
    return c.json({ success: true });
  }

  if (!body.status || !validStatuses.includes(body.status)) {
    return c.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      400
    );
  }

  const updated = updateJobStatus(id, body.status);
  if (!updated) return c.json({ error: "Job not found" }, 404);
  return c.json({ success: true });
});

app.get("/api/job-stats", (c) => {
  return c.json(getJobStats());
});

app.get("/api/job-digest", (c) => {
  const date = c.req.query("date") || undefined;
  return c.json({ digest: generateJobDigest(date) });
});

app.get("/api/jobs/export/csv", (c) => {
  const status = c.req.query("status") || undefined;
  const work_mode = c.req.query("work_mode") || undefined;
  const urgency = c.req.query("urgency") || undefined;
  const jobs = getJobs({ status, work_mode, urgency, limit: 1000, offset: 0 });

  const csvEsc = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
  const header = "Title,Company,Location,Work Mode,Fit Score,Stack Match,Seniority,Urgency,Status,Description,Draft Message,Job URL,Poster,Found";
  const rows = jobs.map((j: any) =>
    [
      csvEsc(j.title), csvEsc(j.company), csvEsc(j.location), j.work_mode,
      Math.round(j.fit_score * 100) + "%", Math.round(j.stack_match * 100) + "%",
      j.seniority_match, j.urgency, j.status,
      csvEsc(j.job_description), csvEsc(j.draft_message),
      j.job_url, csvEsc(j.poster_name),
      j.found_at ? new Date(j.found_at).toLocaleDateString() : "",
    ].join(",")
  );

  const csv = [header, ...rows].join("\n");
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", `attachment; filename="jobs-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body(csv);
});

app.get("/api/jobs/export/html", (c) => {
  const status = c.req.query("status") || undefined;
  const work_mode = c.req.query("work_mode") || undefined;
  const urgency = c.req.query("urgency") || undefined;
  const jobs = getJobs({ status, work_mode, urgency, limit: 1000, offset: 0 });
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const modeColor = (m: string) => m === "remote" ? "#22c55e" : m === "hybrid" ? "#3b82f6" : m === "onsite" ? "#f97316" : "#6b7280";
  const seniorityColor = (s: string) => s === "exact" ? "#22c55e" : s === "close" ? "#eab308" : "#ef4444";

  const jobCards = jobs.map((j: any) => `
    <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1);border-left:4px solid ${modeColor(j.work_mode)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-size:18px;font-weight:700;color:#1a1a2e">${esc(j.title)}</div>
          <div style="font-size:14px;color:#6b7280">${esc(j.company || "")} ${j.location ? "— " + esc(j.location) : ""}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <span style="background:${modeColor(j.work_mode)};color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${j.work_mode}</span>
          <span style="background:${seniorityColor(j.seniority_match)};color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${j.seniority_match}</span>
          <span style="background:#e5e7eb;color:#374151;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">Fit ${Math.round(j.fit_score * 100)}%</span>
        </div>
      </div>
      ${j.salary_range ? `<div style="font-size:13px;color:#22c55e;font-weight:600;margin-bottom:8px">${esc(j.salary_range)}</div>` : ""}
      ${j.job_description ? `<div style="background:#f9fafb;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#374151;line-height:1.5;border:1px solid #e5e7eb">${esc(j.job_description)}</div>` : ""}
      ${j.post_content ? `
        <div style="background:#fefce8;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#713f12;line-height:1.5;border:1px solid #fde68a">
          <div style="font-size:11px;font-weight:600;color:#a16207;margin-bottom:4px;text-transform:uppercase">Hiring Post by ${esc(j.poster_name)}</div>
          ${esc(j.post_content)}
        </div>` : ""}
      ${j.draft_message ? `
        <div style="background:#eff6ff;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#1e40af;line-height:1.5;border:1px solid #bfdbfe">
          <div style="font-size:11px;font-weight:600;color:#60a5fa;margin-bottom:4px;text-transform:uppercase">Draft Message</div>
          ${esc(j.draft_message)}
        </div>` : ""}
      <div style="display:flex;gap:16px;font-size:12px;color:#9ca3af">
        ${j.job_url ? `<a href="${esc(j.job_url)}" style="color:#2563eb;text-decoration:none">Job Listing</a>` : ""}
        ${j.poster_url ? `<a href="${esc(j.poster_url)}" style="color:#2563eb;text-decoration:none">Poster Profile</a>` : ""}
        <span>Stack match: ${Math.round(j.stack_match * 100)}%</span>
        <span>Found: ${j.found_at ? new Date(j.found_at).toLocaleDateString() : "N/A"}</span>
      </div>
    </div>`).join("");

  const highFit = jobs.filter((j: any) => j.fit_score >= 0.7).length;
  const remoteCount = jobs.filter((j: any) => j.work_mode === "remote").length;
  const exactCount = jobs.filter((j: any) => j.seniority_match === "exact").length;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Job Report — ${today}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:720px;margin:0 auto;padding:32px 16px">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-size:28px;font-weight:800;color:#1a1a2e;margin:0 0 4px 0">Job Search Report</h1>
      <p style="font-size:14px;color:#6b7280;margin:0">${today}</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px">
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#1a1a2e">${jobs.length}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Total Jobs</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#22c55e">${highFit}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">High Fit (70%+)</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#3b82f6">${remoteCount}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Remote</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#8b5cf6">${exactCount}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Exact Seniority</div>
      </div>
    </div>
    ${jobCards}
    <div style="text-align:center;margin-top:32px;padding:16px;font-size:12px;color:#9ca3af">Generated by LinkedIn Job Search Pipeline</div>
  </div>
</body></html>`;

  c.header("Content-Type", "text/html");
  c.header("Content-Disposition", `attachment; filename="job-report-${new Date().toISOString().slice(0, 10)}.html"`);
  return c.body(html);
});

// ───── Anusha Job Search API ─────

app.get("/api/anusha-jobs", (c) => {
  const status = c.req.query("status") || undefined;
  const work_mode = c.req.query("work_mode") || undefined;
  const urgency = c.req.query("urgency") || undefined;
  const min_fit = c.req.query("min_fit") ? Number(c.req.query("min_fit")) : undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;

  const jobs = anushaStore.getJobs({ status, work_mode, urgency, min_fit, limit, offset });
  return c.json({ jobs, count: jobs.length });
});

app.get("/api/anusha-jobs/export/csv", (c) => {
  const status = c.req.query("status") || undefined;
  const work_mode = c.req.query("work_mode") || undefined;
  const urgency = c.req.query("urgency") || undefined;
  const jobs = anushaStore.getJobs({ status, work_mode, urgency, limit: 1000, offset: 0 });

  const csvEsc = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
  const header = "Title,Company,Location,Work Mode,Fit Score,Stack Match,Seniority,Urgency,Status,Description,Draft Message,Job URL,Poster,Found";
  const rows = jobs.map((j: any) =>
    [
      csvEsc(j.title), csvEsc(j.company), csvEsc(j.location), j.work_mode,
      Math.round(j.fit_score * 100) + "%", Math.round(j.stack_match * 100) + "%",
      j.seniority_match, j.urgency, j.status,
      csvEsc(j.job_description), csvEsc(j.draft_message),
      j.job_url, csvEsc(j.poster_name),
      j.found_at ? new Date(j.found_at).toLocaleDateString() : "",
    ].join(",")
  );

  const csv = [header, ...rows].join("\n");
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", `attachment; filename="anusha-jobs-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body(csv);
});

app.get("/api/anusha-jobs/export/html", (c) => {
  const status = c.req.query("status") || undefined;
  const work_mode = c.req.query("work_mode") || undefined;
  const urgency = c.req.query("urgency") || undefined;
  const jobs = anushaStore.getJobs({ status, work_mode, urgency, limit: 1000, offset: 0 });
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const modeColor = (m: string) => m === "remote" ? "#22c55e" : m === "hybrid" ? "#3b82f6" : m === "onsite" ? "#f97316" : "#6b7280";
  const seniorityColor = (s: string) => s === "exact" ? "#22c55e" : s === "close" ? "#eab308" : "#ef4444";

  const jobCards = jobs.map((j: any) => `
    <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1);border-left:4px solid ${modeColor(j.work_mode)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-size:18px;font-weight:700;color:#1a1a2e">${esc(j.title)}</div>
          <div style="font-size:14px;color:#6b7280">${esc(j.company || "")} ${j.location ? "— " + esc(j.location) : ""}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <span style="background:${modeColor(j.work_mode)};color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${j.work_mode}</span>
          <span style="background:${seniorityColor(j.seniority_match)};color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">${j.seniority_match}</span>
          <span style="background:#e5e7eb;color:#374151;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">Fit ${Math.round(j.fit_score * 100)}%</span>
        </div>
      </div>
      ${j.salary_range ? `<div style="font-size:13px;color:#22c55e;font-weight:600;margin-bottom:8px">${esc(j.salary_range)}</div>` : ""}
      ${j.job_description ? `<div style="background:#f9fafb;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#374151;line-height:1.5;border:1px solid #e5e7eb">${esc(j.job_description)}</div>` : ""}
      ${j.draft_message ? `
        <div style="background:#eff6ff;border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;color:#1e40af;line-height:1.5;border:1px solid #bfdbfe">
          <div style="font-size:11px;font-weight:600;color:#60a5fa;margin-bottom:4px;text-transform:uppercase">Draft Message</div>
          ${esc(j.draft_message)}
        </div>` : ""}
      <div style="display:flex;gap:16px;font-size:12px;color:#9ca3af">
        ${j.job_url ? `<a href="${esc(j.job_url)}" style="color:#2563eb;text-decoration:none">Job Listing</a>` : ""}
        <span>Stack match: ${Math.round(j.stack_match * 100)}%</span>
        <span>Found: ${j.found_at ? new Date(j.found_at).toLocaleDateString() : "N/A"}</span>
      </div>
    </div>`).join("");

  const highFit = jobs.filter((j: any) => j.fit_score >= 0.7).length;
  const remoteCount = jobs.filter((j: any) => j.work_mode === "remote").length;
  const exactCount = jobs.filter((j: any) => j.seniority_match === "exact").length;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Anusha — Job Report — ${today}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:720px;margin:0 auto;padding:32px 16px">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-size:28px;font-weight:800;color:#1a1a2e;margin:0 0 4px 0">Anusha — Job Search Report</h1>
      <p style="font-size:14px;color:#6b7280;margin:0">${today}</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px">
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#1a1a2e">${jobs.length}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Total Jobs</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#22c55e">${highFit}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">High Fit (70%+)</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#3b82f6">${remoteCount}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Remote</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="font-size:28px;font-weight:800;color:#8b5cf6">${exactCount}</div>
        <div style="font-size:12px;color:#6b7280;font-weight:500">Exact Seniority</div>
      </div>
    </div>
    ${jobCards}
    <div style="text-align:center;margin-top:32px;padding:16px;font-size:12px;color:#9ca3af">Generated by Anusha's Job Search Pipeline</div>
  </div>
</body></html>`;

  c.header("Content-Type", "text/html");
  c.header("Content-Disposition", `attachment; filename="anusha-job-report-${new Date().toISOString().slice(0, 10)}.html"`);
  return c.body(html);
});

app.get("/api/anusha-jobs/:id", (c) => {
  const job = anushaStore.getJobById(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

app.patch("/api/anusha-jobs/:id", async (c) => {
  const body = await c.req.json();
  const validStatuses = ["new", "saved", "applied", "interviewing", "offer", "rejected", "archived"];
  const id = c.req.param("id");

  if (body.notes !== undefined) {
    const updated = anushaStore.updateJobNotes(id, body.notes);
    if (!updated) return c.json({ error: "Job not found" }, 404);
    return c.json({ success: true });
  }

  if (!body.status || !validStatuses.includes(body.status)) {
    return c.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      400
    );
  }

  const updated = anushaStore.updateJobStatus(id, body.status);
  if (!updated) return c.json({ error: "Job not found" }, 404);
  return c.json({ success: true });
});

app.get("/api/anusha-job-stats", (c) => {
  return c.json(anushaStore.getJobStats());
});

app.get("/api/anusha-job-digest", (c) => {
  const date = c.req.query("date") || undefined;
  return c.json({ digest: generateAnushaJobDigest(date) });
});

// Serve static dashboard files at root
app.get("/styles.css", async (c) => {
  const fs = await import("fs");
  const css = fs.readFileSync(path.join(ROOT, "dashboard", "styles.css"), "utf-8");
  return c.text(css, 200, { "Content-Type": "text/css" });
});

app.get("/", async (c) => {
  const fs = await import("fs");
  const html = fs.readFileSync(path.join(ROOT, "dashboard", "index.html"), "utf-8");
  return c.html(html);
});

app.get("/jobs", async (c) => {
  const fs = await import("fs");
  const html = fs.readFileSync(path.join(ROOT, "dashboard", "jobs.html"), "utf-8");
  return c.html(html);
});

app.get("/anusha", async (c) => {
  const fs = await import("fs");
  const html = fs.readFileSync(path.join(ROOT, "dashboard", "anusha-jobs.html"), "utf-8");
  return c.html(html);
});

const PORT = Number(process.env.PORT) || 3847;

console.log(`Dashboard server starting on http://localhost:${PORT}`);
console.log(`API: http://localhost:${PORT}/api/leads`);
console.log(`UI:  http://localhost:${PORT}/`);

serve({ fetch: app.fetch, port: PORT });
