---
name: linkedin-leadgen
description: Automated LinkedIn content keyword search for lead generation. Uses smart DOM discovery + Claude text API to extract and score leads. No fragile CSS selectors, no Vision API.
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["node","npx"],"env":["ANTHROPIC_API_KEY"]}}}
user-invokable: true
---

# LinkedIn Lead Generation

Automated content keyword search on LinkedIn to find potential clients for a software engineering and digital marketing studio.

**Extraction method:** Smart DOM discovery (finds profile links as anchors, walks up to card containers) + Claude text API for parsing and scoring. No class-name selectors. No Vision API.

## When to Use

- Invoke manually with `/linkedin-leadgen` or via scheduled cron job
- Run daily (weekday mornings) to find fresh leads from LinkedIn posts

## Project Location

All scripts and config live at `~/projects/linkedin-leadgen/`.

## CRITICAL: Browser Profile

**ALWAYS use `--profile openclaw` on EVERY browser command.** Do NOT use the Chrome extension relay. Examples:
- `browser navigate --profile openclaw <url>`
- `browser screenshot --profile openclaw`
- `browser wait --profile openclaw --load networkidle`
- `browser evaluate --profile openclaw --fn "..."`

If you omit `--profile openclaw`, the command will fail or use the wrong browser.

## Workflow

Execute these steps in order. If any step fails, log the error and continue to the next search.

### Step 1: Verify LinkedIn Login

1. Run: `browser navigate --profile openclaw https://www.linkedin.com/feed/`
2. Run: `browser wait --profile openclaw --load networkidle`
3. Run: `browser screenshot --profile openclaw`
4. Check the screenshot for signs of being logged in (feed content, nav bar, profile photo)
5. If NOT logged in:
   - STOP and tell the user: "LinkedIn session expired. Run `openclaw browser open --profile openclaw https://linkedin.com` and log in. Then re-run."
   - Do NOT enter credentials automatically.

### Step 2: Load Configuration

1. Run: `exec cat ~/projects/linkedin-leadgen/config/keywords.json`
2. Parse JSON to get `tier1_tier2` and `tier3_ai_founders` keyword arrays
3. Note `max_searches_per_run` (default 8) and `search_delay_ms` (default 5000)

### Step 3: Initialize Database

1. Run: `exec npx tsx ~/projects/linkedin-leadgen/scripts/db.ts init`

### Step 4: Search Loop — For Each Keyword

For each keyword string (up to `max_searches_per_run` total):

**4a. Navigate to search results:**
```
browser navigate --profile openclaw "https://www.linkedin.com/search/results/content/?keywords=<URL_ENCODED_KEYWORD>&sortBy=date_posted"
```
```
browser wait --profile openclaw --load networkidle
```

**4b. Scroll to load results, then extract all result blocks in one call:**
```
browser evaluate --profile openclaw --fn 'async () => {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const getHeight = () => document.documentElement.scrollHeight;
  let prevHeight = 0;
  let scrollCount = 0;
  while (scrollCount < 4) {
    prevHeight = getHeight();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await delay(2500);
    if (getHeight() === prevHeight) break;
    scrollCount++;
  }
  window.scrollTo(0, 0);
  await delay(500);
  const results = [];
  const seen = new Set();
  const profileLinks = document.querySelectorAll("a[href*=\"/in/\"]");
  for (const link of profileLinks) {
    const href = link.getAttribute("href") || "";
    if (!href.includes("/in/")) continue;
    const profileUrl = href.split("?")[0];
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);
    let card = link;
    for (let i = 0; i < 8; i++) {
      if (!card.parentElement) break;
      card = card.parentElement;
      const text = card.innerText || "";
      if (text.length > 100 && card.offsetHeight > 100) break;
    }
    const cardText = (card.innerText || "").trim();
    if (cardText.length < 50) continue;
    const cardLinks = [];
    for (const a of card.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      const t = (a.innerText || "").trim();
      if (t && h && !h.startsWith("javascript")) {
        cardLinks.push({ text: t.slice(0, 100), href: h.split("?")[0] });
      }
    }
    results.push({ profileUrl, cardText: cardText.slice(0, 1500), links: cardLinks.slice(0, 10) });
  }
  return JSON.stringify({ blocks: results, scrolls: scrollCount, total: results.length });
}'
```

**4c. Save the extracted blocks JSON to a temp file:**
```
exec sh -c 'echo '\''<BLOCKS_JSON>'\'' > /tmp/linkedin-blocks-<N>.json'
```

**4d. Run extraction + scoring:**
```
exec npx tsx ~/projects/linkedin-leadgen/scripts/extract.ts --file /tmp/linkedin-blocks-<N>.json --keyword "<KEYWORD>"
```

This sends the blocks to Claude text API, which parses them into structured leads and scores each one. Capture the JSON output.

**4e. Store leads in database:**
Map the output fields and upsert:
- Add `found_at` → current ISO timestamp
- `profileUrl` → `profile_url`, `postContent` → `post_content`, `postUrl` → `post_url`
- `keywordMatch` → `keyword_match`, `draftMessage` → `draft_message`

```
exec npx tsx ~/projects/linkedin-leadgen/scripts/db.ts upsert '<LEADS_JSON>'
```

**4f. Wait between searches:**
```
browser wait --profile openclaw --fn "new Promise(r => setTimeout(r, 5000))"
```

### Step 5: Generate Digest

```
exec npx tsx ~/projects/linkedin-leadgen/scripts/digest.ts
```

Report the digest as your response.

### Step 6: Cleanup

```
exec rm -f /tmp/linkedin-blocks-*.json
```

## Error Handling

- If a search fails (page doesn't load, evaluate returns empty), skip and continue
- If LinkedIn shows CAPTCHA or rate limit, stop all searches and report how many completed
- If Claude API fails, save raw blocks to `/tmp/linkedin-blocks-failed.json` and report error
- Never enter credentials, solve CAPTCHAs, or bypass security measures

## Rate Limiting

- Wait at least 5 seconds between searches
- Max `max_searches_per_run` (default 8) per execution
- The scroll-and-extract JS includes built-in 2.5s delays between scrolls

## Output

Report:
1. Number of searches executed
2. Total result blocks found across all searches
3. Number of leads extracted and scored (after relevance filter)
4. Number of new leads vs duplicates
5. The full digest
6. Any errors
