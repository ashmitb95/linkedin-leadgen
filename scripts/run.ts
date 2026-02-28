/**
 * run.ts — Standalone pipeline runner. No OpenClaw agent needed.
 *
 * Connects to OpenClaw's managed browser (already logged into LinkedIn)
 * via CDP, runs keyword searches, extracts leads, scores them, stores in DB.
 *
 * Two search modes:
 *   1. Content search — regular LinkedIn, finds posts with buying intent
 *   2. Sales Nav search — Sales Navigator people search, finds ICP matches
 *
 * Usage:
 *   npx tsx scripts/run.ts                    # Full run (both modes, all keywords)
 *   npx tsx scripts/run.ts --max 2            # Limit searches per mode
 *   npx tsx scripts/run.ts --keyword "test"   # Single content keyword test
 *   npx tsx scripts/run.ts --content-only     # Only content search
 *   npx tsx scripts/run.ts --salesnav-only    # Only Sales Nav search
 *   npx tsx scripts/run.ts --branding-only    # Only branding/packaging keywords
 *   npx tsx scripts/run.ts --dev-only         # Only dev service keywords
 */

import { loadEnv } from "./env.js";
loadEnv();

import { chromium } from "playwright";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { extractAndScore } from "./extract.js";
import { initDb, upsertLead, logRunStart, logRunEnd, hashPostContent, getSeenPostHashes, markPostsSeen } from "./db.js";
import { generateDigest } from "./digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config", "keywords.json");

// OpenClaw managed browser CDP port
const CDP_PORT = 18800;

interface RunStats {
  searchesRun: number;
  blocksFound: number;
  leadsScored: number;
  leadsNew: number;
  errors: string[];
}

// ───── Browser JS — Content Search (regular LinkedIn) ─────
// Raw ES5 strings to prevent tsx from transforming them
const CONTENT_SCROLL_AND_EXTRACT = `async () => {
  var delay = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var getHeight = function() { return document.documentElement.scrollHeight; };

  var prevHeight = 0;
  var scrollCount = 0;
  var maxScrolls = 4;

  while (scrollCount < maxScrolls) {
    prevHeight = getHeight();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await delay(2500);
    if (getHeight() === prevHeight) break;
    scrollCount++;
  }

  window.scrollTo(0, 0);
  await delay(500);

  var results = [];
  var seen = {};

  var profileLinks = document.querySelectorAll('a[href*="/in/"]');

  for (var i = 0; i < profileLinks.length; i++) {
    var link = profileLinks[i];
    var href = link.getAttribute("href") || "";
    if (href.indexOf("/in/") === -1) continue;

    var profileUrl = href.split("?")[0];
    if (seen[profileUrl]) continue;
    seen[profileUrl] = true;

    var card = link;
    for (var j = 0; j < 8; j++) {
      if (!card.parentElement) break;
      card = card.parentElement;
      var text = card.innerText || "";
      if (text.length > 100 && card.offsetHeight > 100) break;
    }

    var cardText = (card.innerText || "").trim();
    if (cardText.length < 50) continue;

    var cardLinks = [];
    var anchors = card.querySelectorAll("a[href]");
    for (var k = 0; k < anchors.length; k++) {
      var h = anchors[k].getAttribute("href") || "";
      var t = (anchors[k].innerText || "").trim();
      if (t && h && h.indexOf("javascript") !== 0) {
        cardLinks.push({ text: t.slice(0, 100), href: h.split("?")[0] });
      }
    }

    results.push({
      profileUrl: profileUrl,
      cardText: cardText.slice(0, 1500),
      links: cardLinks.slice(0, 10)
    });
  }

  return JSON.stringify({
    blocks: results,
    scrolls: scrollCount,
    total: results.length
  });
}`;

// ───── Browser JS — Sales Navigator People Search ─────
// Sales Nav uses /sales/lead/ links instead of /in/
const SALESNAV_SCROLL_AND_EXTRACT = `async () => {
  var delay = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var getHeight = function() { return document.documentElement.scrollHeight; };

  var prevHeight = 0;
  var scrollCount = 0;
  var maxScrolls = 4;

  while (scrollCount < maxScrolls) {
    prevHeight = getHeight();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await delay(2500);
    if (getHeight() === prevHeight) break;
    scrollCount++;
  }

  window.scrollTo(0, 0);
  await delay(500);

  var results = [];
  var seen = {};

  // Sales Navigator lead links use /sales/lead/ or /sales/people/ paths
  var leadLinks = document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/sales/people/"]');

  // Fallback: also try /in/ links (SN sometimes shows standard profile links)
  if (leadLinks.length === 0) {
    leadLinks = document.querySelectorAll('a[href*="/in/"]');
  }

  for (var i = 0; i < leadLinks.length; i++) {
    var link = leadLinks[i];
    var href = link.getAttribute("href") || "";

    var profileUrl = href.split("?")[0];
    if (seen[profileUrl]) continue;
    seen[profileUrl] = true;

    var card = link;
    for (var j = 0; j < 8; j++) {
      if (!card.parentElement) break;
      card = card.parentElement;
      var text = card.innerText || "";
      if (text.length > 100 && card.offsetHeight > 100) break;
    }

    var cardText = (card.innerText || "").trim();
    if (cardText.length < 50) continue;

    var cardLinks = [];
    var anchors = card.querySelectorAll("a[href]");
    for (var k = 0; k < anchors.length; k++) {
      var h = anchors[k].getAttribute("href") || "";
      var t = (anchors[k].innerText || "").trim();
      if (t && h && h.indexOf("javascript") !== 0) {
        cardLinks.push({ text: t.slice(0, 100), href: h.split("?")[0] });
      }
    }

    results.push({
      profileUrl: profileUrl,
      cardText: cardText.slice(0, 1500),
      links: cardLinks.slice(0, 10)
    });
  }

  return JSON.stringify({
    blocks: results,
    scrolls: scrollCount,
    total: results.length
  });
}`;

// ───── Search executors ─────

interface SearchJob {
  keyword: string;
  mode: "content" | "sales_nav";
  url: string;
  extractJs: string;
}

function buildContentSearchUrl(keyword: string): string {
  return `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&sortBy=date_posted`;
}

function buildSalesNavSearchUrl(keyword: string): string {
  return `https://www.linkedin.com/sales/search/people?query=(keywords%3A${encodeURIComponent(keyword)})`;
}

async function runSearch(
  page: import("playwright").Page,
  job: SearchJob,
  stats: RunStats,
  knownHashes: Set<string>,
  seenInRun: Set<string>
): Promise<void> {
  const shortKeyword =
    job.keyword.length > 50 ? job.keyword.slice(0, 50) + "..." : job.keyword;
  const modeLabel = job.mode === "sales_nav" ? "SN" : "Content";
  console.log(`  [${modeLabel}] Searching: ${shortKeyword}`);

  try {
    await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(4000);

    // Extract blocks (includes scrolling)
    console.log("    Scrolling and extracting...");
    const blocksJson = await page.evaluate(`(${job.extractJs})()`);
    const parsed = JSON.parse(blocksJson as string);
    const blocks: { profileUrl: string; cardText: string; links: unknown[] }[] =
      Array.isArray(parsed) ? parsed : parsed.blocks || [];
    stats.blocksFound += blocks.length;
    console.log(
      `    Found ${blocks.length} result blocks (${parsed.scrolls || 0} scrolls)`
    );

    if (blocks.length === 0) {
      console.log("    No results — skipping scoring");
      stats.searchesRun++;
      return;
    }

    // Filter out already-seen posts before Claude scoring
    const filtered = blocks.filter((b) => {
      const hash = hashPostContent(b.profileUrl, b.cardText);
      if (knownHashes.has(hash) || seenInRun.has(hash)) return false;
      seenInRun.add(hash);
      return true;
    });
    const skipped = blocks.length - filtered.length;
    if (skipped > 0) console.log(`    Skipped ${skipped} already-seen posts`);

    if (filtered.length === 0) {
      console.log("    All posts already seen — skipping scoring");
      stats.searchesRun++;
      return;
    }

    // Score leads via Claude
    const filteredJson = JSON.stringify({
      blocks: filtered,
      scrolls: parsed.scrolls || 0,
      total: filtered.length,
    });
    console.log(`    Scoring ${filtered.length} new blocks with Claude...`);
    const leads = await extractAndScore(filteredJson, job.keyword, job.mode);
    console.log(`    ${leads.length} qualified leads`);
    stats.leadsScored += leads.length;

    // Upsert to DB
    const now = new Date().toISOString();
    for (const lead of leads) {
      const { isNew } = upsertLead({
        name: lead.name,
        headline: lead.headline,
        company: lead.company,
        profile_url: lead.profileUrl || "",
        post_content: lead.postContent,
        post_url: lead.postUrl || "",
        keyword_match: `[${modeLabel}] ${lead.keywordMatch}`,
        tier: lead.tier,
        relevance: lead.relevance,
        urgency: lead.urgency,
        draft_message: lead.draftMessage,
        found_at: now,
      });
      if (isNew) stats.leadsNew++;
    }

    // Mark all extracted blocks as seen for future runs
    markPostsSeen(
      filtered.map((b) => ({
        contentHash: hashPostContent(b.profileUrl, b.cardText),
        profileUrl: b.profileUrl,
      }))
    );

    stats.searchesRun++;
  } catch (err) {
    const msg = `[${modeLabel}] "${shortKeyword}" failed: ${(err as Error).message}`;
    console.error(`    ERROR: ${msg}`);
    stats.errors.push(msg);
    stats.searchesRun++;
  }
}

// ───── Main ─────

async function main() {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf("--max");
  const maxSearches = maxIdx >= 0 ? Number(args[maxIdx + 1]) : undefined;
  const singleKeywordIdx = args.indexOf("--keyword");
  const singleKeyword =
    singleKeywordIdx >= 0 ? args[singleKeywordIdx + 1] : null;
  const contentOnly = args.includes("--content-only");
  const salesnavOnly = args.includes("--salesnav-only");
  const brandingOnly = args.includes("--branding-only");
  const devOnly = args.includes("--dev-only");

  // Init DB
  initDb();

  // Load config
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

  // Select keywords based on --branding-only / --dev-only flags
  function selectKeywords(section: { keywords?: string[]; branding_keywords?: string[] }): string[] {
    const dev = section.keywords || [];
    const branding = section.branding_keywords || [];
    if (brandingOnly) return branding;
    if (devOnly) return dev;
    return [...dev, ...branding];
  }

  // Build search jobs
  const jobs: SearchJob[] = [];

  if (singleKeyword) {
    // Single keyword mode — content search only
    jobs.push({
      keyword: singleKeyword,
      mode: "content",
      url: buildContentSearchUrl(singleKeyword),
      extractJs: CONTENT_SCROLL_AND_EXTRACT,
    });
  } else {
    // Content search jobs
    if (!salesnavOnly) {
      const contentKeywords = selectKeywords(config.content_search || {});
      const contentMax = maxSearches || config.content_search?.max_per_run || 6;
      for (const kw of contentKeywords.slice(0, contentMax)) {
        jobs.push({
          keyword: kw,
          mode: "content",
          url: buildContentSearchUrl(kw),
          extractJs: CONTENT_SCROLL_AND_EXTRACT,
        });
      }
    }

    // Sales Navigator jobs
    if (!contentOnly) {
      const snKeywords = selectKeywords(config.sales_nav_search || {});
      const snMax = maxSearches || config.sales_nav_search?.max_per_run || 4;
      for (const kw of snKeywords.slice(0, snMax)) {
        jobs.push({
          keyword: kw,
          mode: "sales_nav",
          url: buildSalesNavSearchUrl(kw),
          extractJs: SALESNAV_SCROLL_AND_EXTRACT,
        });
      }
    }
  }

  const contentCount = jobs.filter((j) => j.mode === "content").length;
  const snCount = jobs.filter((j) => j.mode === "sales_nav").length;

  console.log(`\n=== LinkedIn Lead Gen Run ===`);
  console.log(`Content searches: ${contentCount}`);
  console.log(`Sales Nav searches: ${snCount}`);
  console.log(`Total: ${jobs.length}`);
  console.log(`Connecting to OpenClaw browser on CDP port ${CDP_PORT}...\n`);

  // Connect to the already-running OpenClaw managed browser
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  } catch (err) {
    console.error(`Failed to connect to browser on port ${CDP_PORT}.`);
    console.error(
      `Make sure OpenClaw gateway is running: openclaw gateway --port 18789`
    );
    console.error(
      `And the managed browser is open: openclaw browser open --profile openclaw https://linkedin.com`
    );
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error("No browser contexts found. Is the browser open?");
    process.exit(1);
  }

  const context = contexts[0];
  const page = await context.newPage();

  const stats: RunStats = {
    searchesRun: 0,
    blocksFound: 0,
    leadsScored: 0,
    leadsNew: 0,
    errors: [],
  };

  const runId = logRunStart();

  // Load seen post hashes for pre-score dedup
  const knownHashes = getSeenPostHashes();
  const seenInRun = new Set<string>();
  console.log(`Loaded ${knownHashes.size} previously seen post hashes\n`);

  // Verify LinkedIn login
  console.log("Checking LinkedIn login...");
  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  await page.waitForTimeout(3000);

  const pageTitle = await page.title();
  const pageUrl = page.url();

  if (
    pageUrl.includes("/login") ||
    pageUrl.includes("/authwall") ||
    pageTitle.toLowerCase().includes("log in") ||
    pageTitle.toLowerCase().includes("sign in")
  ) {
    console.error(
      "\nLinkedIn session expired! Log in manually:\n  openclaw browser open --profile openclaw https://linkedin.com\nThen re-run this script."
    );
    await page.close();
    process.exit(1);
  }

  console.log(`Logged in. Page: "${pageTitle}"\n`);

  // Run all search jobs
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    console.log(`[${i + 1}/${jobs.length}]`);
    await runSearch(page, job, stats, knownHashes, seenInRun);

    // Delay between searches
    if (i < jobs.length - 1) {
      console.log("    Waiting 5s...\n");
      await page.waitForTimeout(5000);
    }
  }

  // Log run
  logRunEnd(runId, {
    searches_run: stats.searchesRun,
    leads_found: stats.leadsScored,
    leads_new: stats.leadsNew,
  });

  await page.close();

  // Print summary
  console.log("\n=== Run Complete ===");
  console.log(`Searches: ${stats.searchesRun}/${jobs.length}`);
  console.log(`Blocks found: ${stats.blocksFound}`);
  console.log(`Leads scored: ${stats.leadsScored}`);
  console.log(`New leads: ${stats.leadsNew}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    for (const e of stats.errors) console.log(`  - ${e}`);
  }

  // Print digest
  console.log("\n" + generateDigest());
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
