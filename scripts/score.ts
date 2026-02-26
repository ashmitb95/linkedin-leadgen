/**
 * score.ts — Re-score existing leads from the database.
 *
 * Useful for re-evaluating leads after changing tier definitions or templates.
 * For normal operation, extract.ts handles scoring via Claude Vision in one pass.
 *
 * Usage:
 *   npx tsx scripts/score.ts --status new        # Re-score all "new" leads
 *   npx tsx scripts/score.ts --file leads.json   # Re-score from file
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { getLeads } from "./db.js";

interface LeadInput {
  name: string;
  headline: string;
  company: string;
  postContent: string;
}

interface ScoreResult {
  name: string;
  tier: number;
  relevance: number;
  urgency: "high" | "medium" | "low";
  draftMessage: string;
  reasoning: string;
}

const SCORING_PROMPT = `You are a lead qualification assistant for a 2-person software engineering and digital marketing studio.

Our services:
- Tier 1 (Quick Cash): Freelance/contract — websites, landing pages, bug fixes, integrations, SEO. $500-$5,000.
- Tier 2 (Product Build): End-to-end builds — MVPs, web apps, mobile apps, internal tools. $5,000-$30,000+.
- Tier 3 (AI Founder Scale-Up): Non-technical AI founders — moving off no-code, proper infra, fractional CTO. $10,000-$50,000+.

Ideal clients: Founders, small biz owners (1-50 employees), non-technical AI builders.
NOT clients: Large enterprises (500+), casual discussion, recruiters, spam.

For each lead, return: name, tier (1/2/3), relevance (0.0-1.0), urgency (high/medium/low), draftMessage (3-4 sentences, personalized, soft CTA), reasoning (1 sentence).

Return ONLY a valid JSON array.`;

export async function rescoreLeads(leads: LeadInput[]): Promise<ScoreResult[]> {
  if (leads.length === 0) return [];

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${SCORING_PROMPT}\n\nLeads:\n${JSON.stringify(leads, null, 2)}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  let jsonStr = content.text.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) jsonStr = match[1].trim();

  const start = jsonStr.indexOf("[");
  const end = jsonStr.lastIndexOf("]");
  if (start === -1 || end === -1) return [];

  return JSON.parse(jsonStr.slice(start, end + 1));
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  const statusIdx = args.indexOf("--status");
  const status = statusIdx >= 0 ? args[statusIdx + 1] : null;

  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;

  let leads: LeadInput[];

  if (filePath) {
    leads = JSON.parse(readFileSync(filePath, "utf-8"));
  } else if (status) {
    const dbLeads = getLeads({ status });
    leads = dbLeads.map((l) => ({
      name: l.name,
      headline: l.headline || "",
      company: l.company || "",
      postContent: l.post_content || "",
    }));
  } else {
    console.error("Usage: npx tsx scripts/score.ts --status new");
    console.error("       npx tsx scripts/score.ts --file leads.json");
    process.exit(1);
  }

  console.error(`Re-scoring ${leads.length} leads...`);
  const results = await rescoreLeads(leads);
  console.log(JSON.stringify(results, null, 2));
}

const isMain = process.argv[1]?.includes("score");
if (isMain) {
  main().catch((err) => {
    console.error("Scoring failed:", err.message);
    process.exit(1);
  });
}
