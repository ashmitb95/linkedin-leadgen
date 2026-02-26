/**
 * job-extract.ts — DOM extraction + Claude scoring for job search pipeline.
 *
 * Two modes:
 *   - content: Hiring announcement posts on LinkedIn
 *   - jobs: Structured job listings from LinkedIn Jobs
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, "..", "config", "job-profile.json");
const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));

export interface ScoredJob {
  title: string;
  company: string;
  location: string;
  workMode: "remote" | "hybrid" | "onsite" | "unknown";
  salaryRange: string | null;
  jobUrl: string;
  applyUrl: string;
  jobDescription: string;
  recruiterName: string;
  recruiterEmail: string;
  recruiterUrl: string;
  posterName: string;
  posterHeadline: string;
  posterUrl: string;
  postContent: string;
  postUrl: string;
  fitScore: number;
  stackMatch: number;
  seniorityMatch: "exact" | "close" | "mismatch";
  urgency: "high" | "medium" | "low";
  reasoning: string;
  draftMessage: string;
  keywordMatch: string;
}

// ───── Scoring Prompts ─────

const HIRING_POST_PROMPT = `You are parsing structured text blocks extracted from LinkedIn content search results. Each block represents a post where someone is announcing a job opening or sharing that their company is hiring.

Each block has:
- profileUrl: the poster's LinkedIn profile URL
- cardText: the raw visible text of their post card
- links: any links found in the card

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

From each block, extract:
- **title**: The job title being hired for (infer from post content)
- **company**: The company hiring (from poster's headline or post text)
- **location**: Extract ANY city, state, country, or region mentioned anywhere in the post text or job description (e.g. "Bangalore, India", "Hyderabad", "Remote - India"). If multiple locations mentioned, list them. Use "Not specified" ONLY if truly no location appears anywhere in the text.
- **workMode**: ONLY set to "remote" if the text explicitly says "remote", "work from home", "WFH", or "fully remote". If a physical location is mentioned without explicit remote language, use "onsite". If both a location AND remote/hybrid are mentioned, use "hybrid". Use "unknown" if no work mode clues exist. Do NOT default to "remote".
- **salaryRange**: If mentioned, extract it (INR or USD). Otherwise null
- **jobUrl**: If the post links to a job listing URL (/jobs/view/...), use it. Otherwise ""
- **applyUrl**: If any link points to a direct application page (careers site, lever, greenhouse, workable, etc.), extract it. Otherwise ""
- **jobDescription**: Key requirements/responsibilities mentioned (summarize in 2-3 sentences)
- **recruiterName**: If the post mentions a hiring manager, recruiter, or says "DM me" / "reach out to [name]" / "contact [name]", extract that person's name. If the poster IS the recruiter/hiring manager, use their name. Otherwise ""
- **recruiterEmail**: If any email address is mentioned in the post text (e.g. "send resume to xyz@company.com"), extract it. Otherwise ""
- **recruiterUrl**: If a recruiter/hiring manager profile URL is mentioned (different from poster), extract it. Otherwise use posterUrl if the poster is the hiring contact.
- **posterName**: The person who posted
- **posterHeadline**: Their professional title
- **posterUrl**: Use the provided profileUrl
- **postContent**: The actual post text (not UI chrome)
- **postUrl**: If any link points to a feed/activity URL, use it. Otherwise ""

Then score each job against the candidate profile:
- **fitScore** (0.0-1.0): Overall match. Consider tech stack overlap, seniority match, work mode, AND location eligibility.
  - 0.8+ = strong match (most required tech matches, right seniority, India-eligible)
  - 0.5-0.8 = partial match (some tech overlap or adjacent seniority)
  - Below 0.3 = poor match (skip)
- **stackMatch** (0.0-1.0): Fraction of the job's required technologies the candidate knows
- **seniorityMatch**: "exact" (matches target roles), "close" (one level off), "mismatch"
- **urgency**: "high" (urgently hiring, immediate start, few applicants), "medium" (standard), "low" (vague or future)
- **reasoning**: One sentence explaining the score. Mention location eligibility.
- **draftMessage**: Personalized 3-4 sentence DM to the poster expressing interest. Reference their post, mention relevant experience briefly, professional tone.

LOCATION FILTER — CRITICAL:
The candidate is based in India. ONLY include jobs that are:
- Located in India (any Indian city)
- Remote with eligibility for India-based candidates (global remote, APAC remote, India remote)
- Remote with no specific country restriction mentioned
SKIP jobs that are:
- Onsite/hybrid in US, EU, UK, or other non-India locations
- Remote but explicitly restricted to US-only, EU-only, specific non-India timezone requirements
- If location is ambiguous, include it but note in reasoning

OTHER FILTERS — Also skip:
- Posts NOT about hiring (industry commentary, articles, etc.)
- Roles requiring technologies the candidate has zero experience with
- Roles clearly below seniority (junior, entry-level, intern, fresher)
- Recruiting agency posts without naming the actual company

Return ONLY a valid JSON array. No markdown, no code blocks.
If no relevant jobs found, return: []`;

const JOB_LISTING_PROMPT = `You are parsing structured text blocks extracted from LinkedIn Jobs search results. Each block is a job listing card.

Each block has:
- jobUrl: the LinkedIn job listing URL
- cardText: the raw visible text of the job card (title, company, location, metadata)
- links: any links found in the card

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

From each block, extract:
- **title**: The exact job title
- **company**: The company name
- **location**: Extract ANY city, state, country, or region from the card text (e.g. "Bangalore, India", "Hyderabad, Telangana"). LinkedIn job cards typically show location — extract it exactly. Use "Not specified" ONLY if no location text exists.
- **workMode**: ONLY set to "remote" if the card explicitly says "Remote", "Work from home", or has a remote badge. If a physical location is shown without explicit remote language, use "onsite". If both location AND remote/hybrid are mentioned, use "hybrid". Use "unknown" only if no clues exist. Do NOT default to "remote".
- **salaryRange**: If shown, extract it (INR or USD). Otherwise null
- **jobUrl**: Use the provided jobUrl
- **applyUrl**: If any link points to an external careers/application page, extract it. Otherwise ""
- **jobDescription**: Whatever description snippet is visible (may be truncated)
- **recruiterName**: If the card shows a recruiter or hiring manager name, extract it. Otherwise ""
- **recruiterEmail**: If any email is visible, extract it. Otherwise ""
- **recruiterUrl**: If a recruiter profile link is visible, extract it. Otherwise ""
- **posterName**: "" (no poster for job listings)
- **posterHeadline**: ""
- **posterUrl**: ""
- **postContent**: ""
- **postUrl**: ""

Score each job against the candidate profile:
- **fitScore** (0.0-1.0): Overall match considering title, visible tech clues, seniority, work mode, AND location eligibility
- **stackMatch** (0.0-1.0): Estimated tech stack overlap from available info (may be limited)
- **seniorityMatch**: "exact", "close", or "mismatch"
- **urgency**: "high" (posted today/yesterday, "Actively recruiting"), "medium" (this week), "low" (older)
- **reasoning**: One sentence. Mention location eligibility.
- **draftMessage**: "" (no DM for job listings — user applies directly)

LOCATION FILTER — CRITICAL:
The candidate is based in India. ONLY include jobs that are:
- Located in India (any Indian city)
- Remote with eligibility for India-based candidates (global remote, APAC remote, India remote)
- Remote with no specific country restriction mentioned
SKIP jobs that are:
- Onsite/hybrid in US, EU, UK, or other non-India locations
- Remote but explicitly restricted to US-only, EU-only, etc.

Job cards have limited description. Score based on what is visible; include India-eligible jobs with fitScore >= 0.3 since the user can click through.

Return ONLY a valid JSON array. No markdown, no code blocks.
If no relevant jobs found, return: []`;

const JOB_BOARD_PROMPT = `You are parsing structured text blocks extracted from an Indian job board (Naukri.com or Hirist.tech). Each block is a job listing card.

Each block has:
- jobUrl: the job listing URL on the board
- cardText: the raw visible text of the job card (title, company, location, experience, skills)
- links: any links found in the card

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

From each block, extract:
- **title**: The exact job title
- **company**: The company name
- **location**: Extract city/cities mentioned (e.g. "Bangalore", "Hyderabad, Pune"). These are Indian job boards so all jobs are India-based.
- **workMode**: "remote" if explicitly marked remote/WFH, "hybrid" if marked hybrid, "onsite" otherwise. Many Naukri listings show a badge.
- **salaryRange**: If shown (e.g. "15-25 LPA", "₹20L - ₹35L"), extract it. Otherwise null
- **jobUrl**: Use the provided jobUrl. Prefix with "https://www.naukri.com" or "https://www.hirist.tech" if it's a relative path.
- **applyUrl**: Use the jobUrl (these boards have direct apply on the listing page)
- **jobDescription**: Whatever skills, experience, and description text is visible
- **recruiterName**: If a recruiter or company HR name is shown, extract it. Otherwise ""
- **recruiterEmail**: If an email is shown, extract it. Otherwise ""
- **recruiterUrl**: ""
- **posterName**: ""
- **posterHeadline**: ""
- **posterUrl**: ""
- **postContent**: ""
- **postUrl**: ""

Score each job against the candidate profile:
- **fitScore** (0.0-1.0): Overall match considering title, tech stack overlap, seniority, experience range
- **stackMatch** (0.0-1.0): Fraction of listed skills the candidate knows
- **seniorityMatch**: "exact", "close", or "mismatch" based on experience range vs 8 YOE
- **urgency**: "high" (posted today/yesterday, "few applicants"), "medium" (this week), "low" (older)
- **reasoning**: One sentence
- **draftMessage**: "" (direct apply on these boards)

All jobs on these boards are India-based, so no location filtering needed. Skip only:
- Roles requiring technologies the candidate has zero experience with
- Roles below seniority (junior, entry-level, 0-3 years)
- Roles WAY above (VP, CTO, Director)

Return ONLY a valid JSON array. No markdown, no code blocks.
If no relevant jobs found, return: []`;

// ───── Scoring Function ─────

export async function extractAndScoreJobs(
  blocksJson: string,
  keyword: string,
  mode: "content" | "jobs" | "naukri" | "hirist" = "content"
): Promise<ScoredJob[]> {
  let blocks: any[];

  try {
    const parsed = JSON.parse(blocksJson);
    blocks = Array.isArray(parsed) ? parsed : parsed.blocks || [];
  } catch {
    console.error("Failed to parse blocks JSON");
    return [];
  }

  if (blocks.length === 0) {
    console.error("No blocks to process");
    return [];
  }

  console.error(`Processing ${blocks.length} job blocks (${mode} mode)...`);

  const truncatedBlocks = blocks.slice(0, 30);
  const prompt = mode === "naukri" || mode === "hirist"
    ? JOB_BOARD_PROMPT
    : mode === "jobs"
      ? JOB_LISTING_PROMPT
      : HIRING_POST_PROMPT;

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nSearch keyword: "${keyword}"\n\nBlocks:\n${JSON.stringify(truncatedBlocks, null, 2)}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  let jsonStr = content.text.trim();

  // Strip code blocks if present
  const codeMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) jsonStr = codeMatch[1].trim();

  const arrayStart = jsonStr.indexOf("[");
  const arrayEnd = jsonStr.lastIndexOf("]");
  if (arrayStart === -1 || arrayEnd === -1) {
    console.error("No JSON array in response:", jsonStr.slice(0, 200));
    return [];
  }

  const jobs: ScoredJob[] = JSON.parse(jsonStr.slice(arrayStart, arrayEnd + 1));

  return jobs
    .map((job) => ({ ...job, keywordMatch: keyword }))
    .filter((job) => job.fitScore >= 0.3);
}

// CLI
const isMain = process.argv[1]?.includes("job-extract");
if (isMain) {
  async function main() {
    const args = process.argv.slice(2);
    const keywordIdx = args.indexOf("--keyword");
    const keyword = keywordIdx >= 0 ? args[keywordIdx + 1] : "unknown";
    const modeIdx = args.indexOf("--mode");
    const mode = (modeIdx >= 0 ? args[modeIdx + 1] : "content") as "content" | "jobs";
    const fileIdx = args.indexOf("--file");
    const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;

    let input = "";
    if (filePath) {
      input = readFileSync(filePath, "utf-8");
    } else if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      input = Buffer.concat(chunks).toString("utf-8");
    } else {
      console.error("Usage: echo '<blocks>' | npx tsx scripts/job-extract.ts --keyword 'search' --mode content");
      process.exit(1);
    }

    const jobs = await extractAndScoreJobs(input.trim(), keyword, mode);
    console.error(`Found ${jobs.length} matching jobs (fitScore >= 0.3)`);
    console.log(JSON.stringify(jobs, null, 2));
  }

  main().catch((err) => {
    console.error("Extraction failed:", err.message);
    process.exit(1);
  });
}
