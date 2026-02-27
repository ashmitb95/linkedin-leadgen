# LinkedIn LeadGen

Automated LinkedIn prospecting and job search platform. Uses browser automation (Playwright + OpenClaw CDP) and Claude AI to discover, extract, score, and surface leads and job opportunities from LinkedIn, Naukri.com, and Hirist.tech.

**Two independent pipelines:**

| Pipeline | Purpose | Sources | Database |
|----------|---------|---------|----------|
| **Lead Gen** | Find freelance/project clients | LinkedIn Content, Sales Navigator | `db/leads.db` |
| **Job Search** | Find senior engineering roles | LinkedIn Content, LinkedIn Jobs, Naukri, Hirist | `db/jobs.db` |

Both pipelines share the same architecture: **Browser → Extract → Claude Score → SQLite → Dashboard**

## How It Works

1. **Browser automation** — Connects to an OpenClaw-managed Chrome instance via CDP (port 18800). Executes vanilla JS to scroll pages and extract DOM content.
2. **Smart DOM extraction** — Uses profile links (`/in/`, `/jobs/view/`) as stable anchors, walks up the DOM tree to find card containers. No fragile CSS selectors.
3. **Claude AI scoring** — Sends extracted text blocks to `claude-sonnet-4-6` for parsing, scoring, and personalized message drafting.
4. **SQLite storage** — Deduplicates by SHA256 hash. Upserts preserve higher scores via COALESCE.
5. **Dashboard** — Hono.js server with REST API and vanilla HTML/CSS/JS dashboards for both pipelines.

## Prerequisites

- **Node.js** >= 18
- **OpenClaw** — Managed browser gateway ([openclaw.com](https://openclaw.com))
- **Anthropic API key** — For Claude scoring
- **LinkedIn account** — Logged in via OpenClaw browser

## Setup

```bash
# Clone and install
git clone <repo-url>
cd linkedin-leadgen
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Initialize databases
npm run db:init
npm run job:db:init
```

### Browser Setup

```bash
# Start OpenClaw gateway
openclaw gateway --port 18789

# Open browser with LinkedIn session
openclaw browser open --profile openclaw https://linkedin.com
```

Log into LinkedIn manually in the opened browser. The session persists across runs.

## Configuration

### `config/keywords.json` — Lead Gen Keywords

```json
{
  "content_search": {
    "keywords": ["looking for a freelance developer", "..."],
    "max_per_run": 6
  },
  "sales_nav_search": {
    "keywords": ["founder MVP", "..."],
    "max_per_run": 4
  },
  "search_delay_ms": 5000
}
```

### `config/templates.json` — Message Templates

Three tiers of outreach templates with `{{name}}` and `{{topic}}` placeholders:
- **Tier 1** — Freelance/contract ($500-$5K)
- **Tier 2** — Product builds ($5K-$30K+)
- **Tier 3** — AI founder scale-up ($10K-$50K+)

### `config/job-keywords.json` — Job Search Keywords

```json
{
  "content_search": {
    "keywords": ["hiring senior fullstack engineer", "..."],
    "max_per_run": 8,
    "max_scrolls": 6
  },
  "jobs_search": {
    "keywords": ["Senior Fullstack Engineer", "..."],
    "max_per_run": 4,
    "max_scrolls": 8,
    "filters": { "date_posted": "past_week", "experience_level": "senior", "remote": true }
  },
  "naukri": {
    "keywords": ["Senior Fullstack Developer", "..."],
    "max_per_run": 4,
    "max_scrolls": 4,
    "filters": { "experience": "5-15", "sort_by": "date" }
  },
  "hirist": {
    "keywords": ["full-stack-jobs", "backend-development-jobs", "..."],
    "max_per_run": 3,
    "max_scrolls": 3
  },
  "search_delay_ms": 5000,
  "quick": {
    "max_per_run": 1,
    "max_scrolls": 2,
    "search_delay_ms": 2000
  }
}
```

### `config/job-profile.json` — Candidate Profile

Defines your tech stack, target roles, seniority, and location preferences. Used by Claude to score job fit.

```json
{
  "years_of_experience": 8,
  "tech_stack": {
    "primary": ["Node.js", "TypeScript", "React", "Next.js", "Python"],
    "secondary": ["NestJS", "MongoDB", "PostgreSQL", "SQL"]
  },
  "target_roles": ["Senior Software Developer", "Senior Fullstack Engineer", "..."],
  "seniority_range": ["Senior", "Lead", "Staff"],
  "location": {
    "country": "India",
    "eligible_for": ["India", "Remote (Global)", "Remote (India)", "Remote (APAC)"]
  },
  "work_preferences": {
    "remote_ok": true,
    "hybrid_ok": true,
    "onsite_ok": true,
    "onsite_cities": ["Bangalore"]
  }
}
```

## Usage

### Lead Generation Pipeline

```bash
npm run lead:run              # Full run — content + Sales Navigator
npm run lead:run:test         # Test mode — single keyword
npm run lead:run:content      # Content search only
npm run lead:run:salesnav     # Sales Navigator only
npm run lead:score            # Re-score existing leads
npm run lead:digest           # Daily digest
```

**CLI flags:**
```bash
npx tsx scripts/run.ts --max 2              # Limit searches per mode
npx tsx scripts/run.ts --keyword "test"     # Single keyword test
```

### Job Search Pipeline

```bash
npm run job:run               # Full run — all 4 sources
npm run job:run:quick         # Smoke test (1 keyword/source, 2 scrolls)
npm run job:run:test          # Single content keyword test
npm run job:run:linkedin      # LinkedIn content + jobs
npm run job:run:naukri        # Naukri.com only
npm run job:run:hirist        # Hirist.tech only
npm run job:run:boards        # Naukri + Hirist
npm run job:digest            # Daily digest
```

**CLI flags:**
```bash
npx tsx scripts/job-run.ts --max 2              # Limit keywords per source
npx tsx scripts/job-run.ts --scrolls 10         # Override scroll depth
npx tsx scripts/job-run.ts --keyword "test"     # Single keyword
```

### Dashboard

```bash
# Start server on port 3847
npm run dashboard

# Development mode with hot reload
npm run dev
```

- **Leads dashboard** — http://localhost:3847/
- **Jobs dashboard** — http://localhost:3847/jobs

**Features:**
- Stat cards with real-time counts
- Filter by status, tier/urgency, work mode, seniority match
- Expandable job/lead cards with full details
- Copy draft messages, open external links, add notes
- Export to CSV or styled HTML report

### Database Management

```bash
npm run lead:db:init      # Initialize lead tables
npm run lead:db:stats     # Lead statistics
npm run job:db:init       # Initialize job tables
npm run job:db:stats      # Job statistics
```

## API Reference

### Lead Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/leads` | List leads (query: `status`, `tier`, `urgency`, `limit`, `offset`) |
| `GET` | `/api/leads/:id` | Get single lead |
| `PATCH` | `/api/leads/:id` | Update status (`new`, `contacted`, `replied`, `archived`) |
| `GET` | `/api/stats` | Aggregate statistics |
| `GET` | `/api/runs` | Pipeline run history |
| `GET` | `/api/digest` | Daily digest (query: `date`) |
| `GET` | `/api/export/csv` | Export as CSV |
| `GET` | `/api/export/html` | Export as styled HTML report |

### Job Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/jobs` | List jobs (query: `status`, `work_mode`, `urgency`, `min_fit`) |
| `GET` | `/api/jobs/:id` | Get single job |
| `PATCH` | `/api/jobs/:id` | Update status + notes (`new`, `saved`, `applied`, `interviewing`, `offer`, `rejected`, `archived`) |
| `GET` | `/api/job-stats` | Aggregate statistics |
| `GET` | `/api/job-digest` | Daily digest (query: `date`) |
| `GET` | `/api/jobs/export/csv` | Export as CSV |
| `GET` | `/api/jobs/export/html` | Export as styled HTML report |

## Project Structure

```
linkedin-leadgen/
├── config/
│   ├── keywords.json         # Lead gen search keywords
│   ├── templates.json        # Outreach message templates (3 tiers)
│   ├── job-keywords.json     # Job search keywords + scroll config
│   └── job-profile.json      # Candidate profile for job scoring
├── scripts/
│   ├── run.ts                # Lead gen pipeline runner
│   ├── job-run.ts            # Job search pipeline runner (4 sources)
│   ├── extract.ts            # Lead DOM extraction + Claude scoring
│   ├── job-extract.ts        # Job DOM extraction + Claude scoring
│   ├── db.ts                 # Lead SQLite layer
│   ├── job-db.ts             # Job SQLite layer
│   ├── digest.ts             # Lead daily digest
│   ├── job-digest.ts         # Job daily digest
│   ├── score.ts              # Re-score existing leads
│   └── serve-dashboard.ts    # Hono API server + static files
├── dashboard/
│   ├── index.html            # Lead dashboard UI
│   ├── jobs.html             # Job search dashboard UI
│   └── styles.css            # Dark theme stylesheet
├── db/                       # SQLite databases (auto-created)
├── package.json
└── tsconfig.json
```

## Job Scoring

Each job is scored by Claude against your `job-profile.json`:

| Field | Range | Description |
|-------|-------|-------------|
| `fitScore` | 0.0–1.0 | Overall match (tech, seniority, location, work mode) |
| `stackMatch` | 0.0–1.0 | Fraction of required tech you know |
| `seniorityMatch` | exact / close / mismatch | Role level vs your target |
| `urgency` | high / medium / low | Hiring timeline signals |

**Threshold:** Only jobs with `fitScore >= 0.3` are saved.

**Location filter:** The job pipeline only surfaces India-based or India-eligible remote roles. US/EU-only positions are automatically filtered out.

## Lead Scoring

Each lead is scored with:

| Field | Range | Description |
|-------|-------|-------------|
| `relevance` | 0.0–1.0 | How likely they need your services |
| `tier` | 1–3 | Revenue potential (1=freelance, 2=product, 3=scale-up) |
| `urgency` | high / medium / low | How urgently they need help |
| `draftMessage` | string | Personalized outreach draft |

**Threshold:** Only leads with `relevance >= 0.3` are saved.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for scoring |
| `PORT` | No | Dashboard server port (default: 3847) |

## Tech Stack

- **TypeScript** + **tsx** — Scripts and type safety
- **Playwright** — CDP browser connection
- **Anthropic SDK** — Claude API for extraction and scoring
- **better-sqlite3** — Local database with WAL mode
- **Hono** — Lightweight web framework for dashboard API

## License

MIT
