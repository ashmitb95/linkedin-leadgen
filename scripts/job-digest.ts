/**
 * job-digest.ts — Daily summary for job search pipeline.
 */

import { initDb, getTodayJobs, getJobStats, getDb } from "./job-db.js";

export function generateJobDigest(date?: string): string {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const db = getDb();

  const dayJobs = db.prepare(
    "SELECT * FROM jobs WHERE found_at >= ? AND found_at < ? ORDER BY fit_score DESC"
  ).all(targetDate + "T00:00:00", targetDate + "T23:59:59") as any[];

  const latestRun = db.prepare(
    "SELECT * FROM job_runs WHERE started_at >= ? ORDER BY id DESC LIMIT 1"
  ).get(targetDate + "T00:00:00") as any;

  const allStats = db.prepare("SELECT COUNT(*) as total FROM jobs").get() as any;
  const statusCounts = db.prepare(
    "SELECT status, COUNT(*) as count FROM jobs GROUP BY status"
  ).all() as any[];

  db.close();

  const statusMap: Record<string, number> = {};
  for (const s of statusCounts) statusMap[s.status] = s.count;

  const highFit = dayJobs.filter((j) => j.fit_score >= 0.7);
  const remote = dayJobs.filter((j) => j.work_mode === "remote");
  const exact = dayJobs.filter((j) => j.seniority_match === "exact");

  let digest = `## Job Search Report — ${targetDate}\n\n`;

  digest += `### Run Summary\n`;
  digest += `- Searches run: ${latestRun?.searches_run ?? 0}\n`;
  digest += `- Jobs found: ${dayJobs.length}\n`;
  digest += `- New jobs: ${latestRun?.jobs_new ?? 0}\n`;
  digest += `- High fit (70%+): ${highFit.length}\n`;
  digest += `- Remote: ${remote.length}\n`;
  digest += `- Exact seniority match: ${exact.length}\n\n`;

  digest += `### Pipeline Totals\n`;
  digest += `- Total jobs: ${allStats.total}\n`;
  digest += `- New: ${statusMap["new"] || 0} | Saved: ${statusMap["saved"] || 0} | Applied: ${statusMap["applied"] || 0}`;
  digest += ` | Interviewing: ${statusMap["interviewing"] || 0} | Offer: ${statusMap["offer"] || 0}`;
  digest += ` | Rejected: ${statusMap["rejected"] || 0} | Archived: ${statusMap["archived"] || 0}\n\n`;

  if (highFit.length > 0) {
    digest += `### Top Matches\n\n`;
    for (const j of highFit.slice(0, 10)) {
      const fitPct = Math.round(j.fit_score * 100);
      const stackPct = Math.round(j.stack_match * 100);
      digest += `**${j.title}** — ${j.company || "Unknown"}\n`;
      digest += `  ${j.location || "Location N/A"} | ${j.work_mode} | Seniority: ${j.seniority_match}\n`;
      if (j.job_description) {
        digest += `  ${j.job_description.slice(0, 120)}...\n`;
      }
      digest += `  Fit: ${fitPct}% | Stack: ${stackPct}% | Urgency: ${j.urgency}\n`;
      if (j.draft_message) {
        digest += `  Draft: "${j.draft_message.slice(0, 100)}..."\n`;
      }
      if (j.job_url) digest += `  [Job Listing](${j.job_url})\n`;
      if (j.poster_url) digest += `  [Posted by ${j.poster_name}](${j.poster_url})\n`;
      digest += `\n`;
    }
  }

  const mediumFit = dayJobs.filter((j) => j.fit_score >= 0.4 && j.fit_score < 0.7);
  if (mediumFit.length > 0) {
    digest += `### Other Matches (${mediumFit.length})\n\n`;
    for (const j of mediumFit.slice(0, 5)) {
      const fitPct = Math.round(j.fit_score * 100);
      digest += `**${j.title}** — ${j.company || "Unknown"} | ${j.work_mode} | Fit: ${fitPct}%\n`;
    }
    digest += `\n`;
  }

  if (dayJobs.length === 0) {
    digest += `*No new jobs found today.*\n`;
  }

  return digest;
}

const isMain = process.argv[1]?.includes("job-digest");
if (isMain) {
  initDb();
  const date = process.argv[2] || undefined;
  console.log(generateJobDigest(date));
}
