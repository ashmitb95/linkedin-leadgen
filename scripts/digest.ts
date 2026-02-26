/**
 * digest.ts — Generate a daily summary of new leads.
 *
 * Queries SQLite for today's leads and formats a markdown digest
 * for display on the dashboard or in notifications.
 *
 * Usage:
 *   npx tsx scripts/digest.ts              # Today's leads
 *   npx tsx scripts/digest.ts --date 2026-02-27  # Specific date
 */

import { getDb, getStats } from "./db.js";
import type { Lead } from "./db.js";

export function generateDigest(date?: string): string {
  const db = getDb();
  const targetDate = date || new Date().toISOString().split("T")[0];

  const leads = db
    .prepare(
      "SELECT * FROM leads WHERE found_at >= ? AND found_at < date(?, '+1 day') ORDER BY relevance DESC"
    )
    .all(targetDate, targetDate) as Lead[];

  const latestRun = db
    .prepare("SELECT * FROM runs WHERE started_at >= ? ORDER BY id DESC LIMIT 1")
    .get(targetDate) as { searches_run: number; leads_found: number; leads_new: number } | undefined;

  db.close();

  const stats = getStats();

  const highUrgency = leads.filter((l) => l.urgency === "high");
  const mediumUrgency = leads.filter((l) => l.urgency === "medium");
  const lowUrgency = leads.filter((l) => l.urgency === "low");

  const tierCounts = [1, 2, 3].map(
    (t) => leads.filter((l) => l.tier === t).length
  );

  let md = `## LinkedIn Lead Gen Report — ${targetDate}\n\n`;

  md += `### Run Summary\n`;
  md += `- Searches run: ${latestRun?.searches_run ?? "N/A"}\n`;
  md += `- Leads found: ${leads.length}\n`;
  md += `- New leads: ${latestRun?.leads_new ?? leads.length}\n`;
  md += `- High urgency: ${highUrgency.length}\n`;
  md += `- Tier breakdown: T1: ${tierCounts[0]} | T2: ${tierCounts[1]} | T3: ${tierCounts[2]}\n\n`;

  md += `### Pipeline Totals\n`;
  md += `- Total leads: ${stats.total_leads}\n`;
  md += `- New: ${stats.new_leads} | Contacted: ${stats.contacted} | Replied: ${stats.replied} | Archived: ${stats.archived}\n\n`;

  if (highUrgency.length > 0) {
    md += `### High Priority Leads\n\n`;
    for (const lead of highUrgency) {
      md += formatLeadEntry(lead);
    }
  }

  if (mediumUrgency.length > 0) {
    md += `### Medium Priority Leads\n\n`;
    for (const lead of mediumUrgency) {
      md += formatLeadEntry(lead);
    }
  }

  if (lowUrgency.length > 0) {
    md += `### Other Leads\n\n`;
    for (const lead of lowUrgency) {
      md += formatLeadEntry(lead);
    }
  }

  if (leads.length === 0) {
    md += `*No new leads found today.*\n`;
  }

  return md;
}

function formatLeadEntry(lead: Lead): string {
  const tierLabel = lead.tier === 1 ? "T1-Freelance" : lead.tier === 2 ? "T2-Product" : "T3-AIScale";
  const postSnippet = lead.post_content
    ? lead.post_content.slice(0, 120) + (lead.post_content.length > 120 ? "..." : "")
    : "N/A";

  let entry = `**${lead.name}**`;
  if (lead.company) entry += ` — ${lead.company}`;
  entry += `\n`;
  if (lead.headline) entry += `  ${lead.headline}\n`;
  entry += `  Post: "${postSnippet}"\n`;
  entry += `  ${tierLabel} | Relevance: ${lead.relevance.toFixed(2)} | Urgency: ${lead.urgency}\n`;
  if (lead.draft_message) {
    entry += `  Draft: "${lead.draft_message.slice(0, 100)}..."\n`;
  }
  if (lead.profile_url) {
    entry += `  [Profile](${lead.profile_url})\n`;
  }
  entry += `\n`;
  return entry;
}

// CLI — only run when executed directly, not when imported
const isMain = process.argv[1]?.includes("digest");
if (isMain) {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 ? args[dateIdx + 1] : undefined;
  console.log(generateDigest(date));
}
