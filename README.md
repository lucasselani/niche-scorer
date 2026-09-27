# Niche Scorer

A private command-line research tool that scores YouTube content topics ("niches") by **audience demand** and **room for small channels**, using public data from the YouTube Data API v3.

It is used by a single operator to plan content for their own channels. It has no users, no website and no user interface, and it never republishes YouTube content or data.

## What it does

For each topic in a config file, and for each language/region you choose, it:

1. Runs keyword searches with `search.list` (ordered by view count and by date, published in the last 12 months).
2. Fetches public statistics for the returned videos (`videos.list`) and their channels (`channels.list`).
3. Keeps only long-form videos by default (≥ 8 minutes), so Shorts don't distort the numbers.
4. Computes aggregate indicators and writes a private report (`niche-report.json` and `niche-report.csv`).

### Indicators

| Indicator | Meaning |
|---|---|
| `demand` (0–100) | Median views per day of the top videos for the topic (log scale: 100 VPD = 0, 20,000 VPD = 100) |
| `opportunity` (0–100) | How often small channels (≤ 50k subscribers) have videos that outperform their size (views ≥ subscribers, ≥ 300 views/day, ≥ 14 days old), how many distinct channels do it, the median views/subscribers ratio, and how many of them are new channels (≤ 180 days) |
| `attention` | 40% demand + 60% opportunity |
| `money` | `attention` adjusted by a rough, editable monetization factor per video category and region |
| `top5ChannelShare` | Share of views held by the 5 largest channels (high = dominated by a few players) |
| `status` | 🔥 new channels breaking out · 🟦 promising · 🟥 dominated by big players · 🟧 high demand, hard entry · ⬜ low demand · 📊 stable |

Scores use fixed reference points, so results are comparable across runs.

The report also lists, per topic: rising new channels, the top 25 outlier videos (sorted by views/subscribers) and the most common words in their titles.

## Requirements

- Node.js 18+ (no dependencies)
- One YouTube Data API v3 key from your own Google Cloud project

## Setup

1. In the Google Cloud console, enable **YouTube Data API v3** and create an **API key** (restrict it to that API).
2. Create a `.env` file (never commit it):
   ```
   YT_API_KEY=your_api_key
   ```
3. Copy `niches.example.json` to `niches.json` and edit your topics.

## Usage

```bash
# Estimate quota cost without calling the API
node niche-scorer.mjs --config niches.json --locales en:US --dry-run

# Run (Node 20.6+ reads .env directly)
node --env-file=.env niche-scorer.mjs --config niches.json --locales en:US,en:GB

# Node 18
YT_API_KEY=your_api_key node niche-scorer.mjs --config niches.json --locales en:US
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--config` | `niches.json` | Topics and search phrases per language (JSON or JSONC) |
| `--locales` | languages in config | Comma-separated `language:REGION` pairs, e.g. `en:US,en:GB,pt:BR` |
| `--niches` | all | Comma-separated topic ids to run |
| `--pages` | `2` | Result pages (50 each) per search phrase and ordering |
| `--passes` | `viewCount,date` | Search orderings |
| `--format` | `long` | `long`, `shorts` or `all` |
| `--min-long-sec` | `480` | Minimum duration for long-form videos |
| `--months` | `12` | Publication window |
| `--out` | `niche-report` | Output file prefix |
| `--cache-hours` | `24` | Local cache lifetime for API responses |
| `--dry-run` | — | Only estimate quota |

## Config format

```json
{
  "niches": [
    {
      "id": "car-ownership-costs",
      "label": "Car ownership costs and reliability",
      "rpm": 1.0,
      "queries": {
        "en": ["cheap reliable used cars", "cars that last forever"],
        "pt": ["carros baratos que duram muito"]
      }
    }
  ]
}
```

- `id`: topic identifier used in reports.
- `label`: optional description.
- `rpm`: optional monetization factor (0.1–1.0) that overrides the category default.
- `queries`: search phrases per language; a language is used only when it appears in `--locales`.

## Quota and API compliance

- Each `search.list` call costs 100 units; `videos.list` and `channels.list` cost 1 unit per call of up to 50 ids. The default quota is 10,000 units per day.
- Approximate cost: `phrases × orderings × pages × 100` per topic and region. Use `--dry-run` first.
- The tool uses **one API key from one project** and does not rotate keys. If quota runs out, it saves partial results and exits; the next run reuses the cache and continues.
- It only reads public data with an API key (no OAuth, no private data), does not scrape YouTube pages, and does not download videos.
- API responses are cached locally for at most 24 hours. Reports are private and should be refreshed or deleted within 30 days.
- Use of this tool is subject to the [YouTube Terms of Service](https://www.youtube.com/t/terms) and the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service). See [PRIVACY.md](PRIVACY.md).

## Output

- `niche-report.json`: full results, sorted by `money` score, with metadata (`partial`, estimated quota used, cache hits).
- `niche-report.csv`: one row per topic and region with the main scores.