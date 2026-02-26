/**
 * extract.ts — Two-part extraction: smart DOM discovery + Claude text parsing.
 *
 * Part 1 (browser JS): Walks the DOM to find repeating result containers by
 *   structural pattern (not class names). Extracts clean text blocks per result.
 * Part 2 (Claude text API): Parses the clean blocks into structured, scored leads.
 *
 * Usage:
 *   echo '<extracted blocks json>' | npx tsx scripts/extract.ts --keyword "search"
 *   npx tsx scripts/extract.ts --file /tmp/blocks.json --keyword "search"
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";

export interface ScoredLead {
  name: string;
  headline: string;
  company: string;
  profileUrl: string;
  postContent: string;
  postUrl: string;
  keywordMatch: string;
  tier: number;
  relevance: number;
  urgency: "high" | "medium" | "low";
  draftMessage: string;
  reasoning: string;
}

/**
 * Part 1 — Inject via `browser evaluate`.
 *
 * Finds repeating result blocks on LinkedIn search results by:
 * 1. Looking for all links containing "/in/" (profile links) as anchors
 * 2. Walking up to find their common ancestor container (the "result card")
 * 3. Extracting structured text from each card
 *
 * This approach uses profile link hrefs as the anchor point — LinkedIn will
 * always have profile links in search results regardless of class name changes.
 */
export const DISCOVER_AND_EXTRACT_JS = `() => {
  const results = [];
  const seen = new Set();

  // Find all profile links — the one stable anchor in LinkedIn search results
  const profileLinks = document.querySelectorAll('a[href*="/in/"]');

  for (const link of profileLinks) {
    const href = link.getAttribute('href') || '';
    // Skip non-profile links (company pages, etc.)
    if (!href.includes('/in/')) continue;

    // Clean profile URL
    const profileUrl = href.split('?')[0];
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);

    // Walk up to find the result card container (usually 3-6 levels up)
    let card = link;
    for (let i = 0; i < 8; i++) {
      if (!card.parentElement) break;
      card = card.parentElement;
      // Stop when we hit something that looks like a result container
      // (has enough text content and is a reasonable size)
      const text = card.innerText || '';
      if (text.length > 100 && card.offsetHeight > 100) break;
    }

    const cardText = (card.innerText || '').trim();
    if (cardText.length < 50) continue;

    // Extract all links from this card for context
    const cardLinks = [];
    for (const a of card.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      const t = (a.innerText || '').trim();
      if (t && h && !h.startsWith('javascript')) {
        cardLinks.push({ text: t.slice(0, 100), href: h.split('?')[0] });
      }
    }

    results.push({
      profileUrl,
      cardText: cardText.slice(0, 1500),
      links: cardLinks.slice(0, 10)
    });
  }

  return JSON.stringify(results);
}`;

/**
 * Part 1b — Scroll to load more results, then extract.
 * Combines scrolling + extraction in one evaluate call.
 */
export const SCROLL_AND_EXTRACT_JS = `async () => {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const getHeight = () => document.documentElement.scrollHeight;

  // Scroll down to load lazy results
  let prevHeight = 0;
  let scrollCount = 0;
  const maxScrolls = 4;

  while (scrollCount < maxScrolls) {
    prevHeight = getHeight();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await delay(2500);
    if (getHeight() === prevHeight) break;
    scrollCount++;
  }

  window.scrollTo(0, 0);
  await delay(500);

  // Now extract
  const results = [];
  const seen = new Set();

  const profileLinks = document.querySelectorAll('a[href*="/in/"]');

  for (const link of profileLinks) {
    const href = link.getAttribute('href') || '';
    if (!href.includes('/in/')) continue;

    const profileUrl = href.split('?')[0];
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);

    let card = link;
    for (let i = 0; i < 8; i++) {
      if (!card.parentElement) break;
      card = card.parentElement;
      const text = card.innerText || '';
      if (text.length > 100 && card.offsetHeight > 100) break;
    }

    const cardText = (card.innerText || '').trim();
    if (cardText.length < 50) continue;

    const cardLinks = [];
    for (const a of card.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      const t = (a.innerText || '').trim();
      if (t && h && !h.startsWith('javascript')) {
        cardLinks.push({ text: t.slice(0, 100), href: h.split('?')[0] });
      }
    }

    results.push({
      profileUrl,
      cardText: cardText.slice(0, 1500),
      links: cardLinks.slice(0, 10)
    });
  }

  return JSON.stringify({ blocks: results, scrolls: scrollCount, total: results.length });
}`;

// ───── Part 2: Claude text API ─────

const CONTENT_SEARCH_PROMPT = `You are parsing structured text blocks extracted from LinkedIn content search results. Each block represents one search result card containing a person's post.

Each block has:
- profileUrl: their LinkedIn profile URL
- cardText: the raw visible text of their result card
- links: any links found in the card

From each block, extract:
- **name**: The person's full name (usually the first prominent text)
- **headline**: Their professional title/headline
- **company**: Extracted from headline (e.g., "VP Engineering at Acme" → "Acme")
- **profileUrl**: Use the provided profileUrl
- **postContent**: The text of their actual post (not UI chrome)
- **postUrl**: If any link points to a feed/update URL, use it. Otherwise ""

Then score each lead for a 2-person software engineering + digital marketing studio:

**Our services:**
- Tier 1: Freelance/contract — websites, landing pages, bug fixes, SEO. $500-$5K.
- Tier 2: Product builds — MVPs, web apps, mobile apps. $5K-$30K+.
- Tier 3: AI founder scale-up — moving off no-code, proper infra, fractional CTO. $10K-$50K+.

**Ideal clients:** Founders, small biz owners (1-50 employees), non-technical AI builders.
**NOT clients:** Large enterprises (500+), casual chat, recruiters, spam, ads.

For each lead:
- **tier** (1, 2, or 3)
- **relevance** (0.0-1.0) — 0.8+ strong, 0.5-0.8 maybe, below 0.3 skip
- **urgency** — "high" (actively looking for help), "medium" (discussing pain), "low" (tangential)
- **draftMessage** — Personalized 3-4 sentence DM. Reference their post. Soft CTA.
- **reasoning** — One sentence

Skip promoted/ad content and irrelevant posts.
Return ONLY a valid JSON array. No markdown, no code blocks.
If no relevant leads found, return: []`;

const SALES_NAV_PROMPT = `You are parsing structured text blocks extracted from LinkedIn Sales Navigator people search results. Each block is a lead profile card (NOT a post — these are profile summaries).

Each block has:
- profileUrl: their Sales Navigator or LinkedIn profile URL
- cardText: the raw visible text of their result card (name, headline, company, location, connections info)
- links: any links found in the card

From each block, extract:
- **name**: The person's full name
- **headline**: Their professional title/headline
- **company**: Their current company
- **profileUrl**: Use the provided profileUrl. If it's a /sales/lead/ URL, keep it as-is.
- **postContent**: Set to "" (no post content in people search)
- **postUrl**: Set to ""

Then score each lead for a 2-person software engineering + digital marketing studio:

**Our services:**
- Tier 1: Freelance/contract — websites, landing pages, bug fixes, SEO. $500-$5K.
- Tier 2: Product builds — MVPs, web apps, mobile apps. $5K-$30K+.
- Tier 3: AI founder scale-up — moving off no-code, proper infra, fractional CTO. $10K-$50K+.

**Ideal clients:** Founders, small biz owners (1-50 employees), non-technical AI builders, solo entrepreneurs.
**NOT clients:** Large enterprises (500+), recruiters, job seekers, students, engineers/developers (they ARE developers, not clients).

Score based on their PROFILE (headline, company, role) — not post content:
- **tier** (1, 2, or 3) — infer from their role/company
- **relevance** (0.0-1.0) — how well they match our ICP. Founders/owners of small companies = high. Developers/engineers = 0.0.
- **urgency** — "low" for all (profile match only, no active buying signal)
- **draftMessage** — Personalized 3-4 sentence cold DM. Reference their company/role. Soft CTA offering to help.
- **reasoning** — One sentence

IMPORTANT: Be selective. Only include leads that are clearly potential CLIENTS (non-technical decision-makers who might need dev services). Filter out developers, engineers, recruiters, students, and people at large companies.
Return ONLY a valid JSON array. No markdown, no code blocks.
If no relevant leads found, return: []`;

export async function extractAndScore(
  blocksJson: string,
  keyword: string,
  mode: "content" | "sales_nav" = "content"
): Promise<ScoredLead[]> {
  let blocks: { profileUrl: string; cardText: string; links: { text: string; href: string }[] }[];

  try {
    const parsed = JSON.parse(blocksJson);
    // Handle both direct array and wrapped { blocks: [...] } format
    blocks = Array.isArray(parsed) ? parsed : parsed.blocks || [];
  } catch {
    console.error("Failed to parse blocks JSON");
    return [];
  }

  if (blocks.length === 0) {
    console.error("No blocks to process");
    return [];
  }

  console.error(`Processing ${blocks.length} result blocks (${mode} mode)...`);

  // Truncate to fit context — each block is ~500-1500 chars
  const truncatedBlocks = blocks.slice(0, 30);

  const prompt = mode === "sales_nav" ? SALES_NAV_PROMPT : CONTENT_SEARCH_PROMPT;
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

  const leads: ScoredLead[] = JSON.parse(jsonStr.slice(arrayStart, arrayEnd + 1));

  return leads
    .map((lead) => ({ ...lead, keywordMatch: keyword }))
    .filter((lead) => lead.relevance >= 0.3);
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  const keywordIdx = args.indexOf("--keyword");
  const keyword = keywordIdx >= 0 ? args[keywordIdx + 1] : "unknown";

  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;

  let input = "";

  if (filePath) {
    input = readFileSync(filePath, "utf-8");
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString("utf-8");
  } else {
    console.error("Usage:");
    console.error(
      "  echo '<blocks json>' | npx tsx scripts/extract.ts --keyword 'search'"
    );
    console.error(
      "  npx tsx scripts/extract.ts --file blocks.json --keyword 'search'"
    );
    process.exit(1);
  }

  const leads = await extractAndScore(input.trim(), keyword);
  console.error(`Found ${leads.length} qualified leads (relevance >= 0.3)`);
  console.log(JSON.stringify(leads, null, 2));
}

const isMain = process.argv[1]?.includes("extract");
if (isMain) {
  main().catch((err) => {
    console.error("Extraction failed:", err.message);
    process.exit(1);
  });
}
