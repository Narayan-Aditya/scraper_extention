# Insta Handle Finder

Seven tools in one side panel, switched with the tabs at the top:

| Mode | What it does |
|---|---|
| **Google handles** | Walks `site:instagram.com "<city>"` Google results and collects public profile handles. |
| **Instagram profiles** | Takes profile URLs/handles and exports each account's full profile + every post to `<handle>.json`. |
| **YouTube channels** | Takes channel URLs/@handles and exports each channel's full profile + every video to `<handle>.json`. |
| **LinkedIn posts** | Takes a LinkedIn search-results URL and exports every post the search returns to `linkedin-<keywords>.json`. |
| **IG discovery** | Walks Instagram's *own* suggestion graph from a seed creator/phrase/hashtag and produces a scored list of creator handles. |
| **Brief → creators** | Reads a campaign brief, runs discovery from it, and exports the top N creators (profile + N posts each) into one download folder. |
| **Brands → contacts** | Takes a list of brand names and builds a decision-maker row per brand — who the owner/director is, their number and address where public, and the company's own contacts kept separate from theirs. |

Modes 1-5 are independent — separate runs, separate tabs, separate saved state —
so the natural workflow is to find handles (mode 1 or mode 5) and feed them into
the second. Mode 6 is that workflow already wired together for one brief.

**Which handle-finder to use.** Mode 1 asks Google, which carries no creator
signal at all and dedupes `site:` results hard — it finds Instagram accounts, not
specifically creators. Mode 5 asks Instagram, which knows exactly which accounts
are similar to a creator you already like. For finding creators, start with mode 5.

## Setup

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extension` folder.
4. The extension icon (purple "IH") should appear in the toolbar. Pin it for
   easy access if you like.
5. Clicking the icon opens the extension as a **side panel** docked to the
   right of the browser window (not a dropdown popup) — it stays open and
   keeps its own state even as the tab next to it navigates from page to
   page, so it never reloads or loses progress mid-run.

Whenever you (or I) change any of the extension's files, come back to
`chrome://extensions` and click the reload icon (🔄) on the extension's card
to pick up the changes.

### Permissions it asks for, and why

Chrome shows these on the extension's card. Nothing here talks to a server that
isn't Google or Instagram — there is no backend, no telemetry, no account.

| Permission | Why it is needed |
|---|---|
| `tabs`, `scripting` | Open and drive the one working tab, and inject the scraper into it |
| `storage`, `unlimitedStorage` | Keep run state and collected posts across restarts; a 16k-post account exceeds the default 10 MB quota |
| `alarms` | Pace the run in a way that survives the service worker being shut down |
| `notifications` | Tell you when a run pauses and needs you |
| `sidePanel` | The UI itself |
| `downloads` | Save `<handle>.json` |
| `offscreen` | A service worker can't create a blob URL, so a hidden page does it |
| `https://www.google.com/*` | Mode 1 — read search results |
| `https://www.instagram.com/*`, `https://instagram.com/*`, `https://i.instagram.com/*` | Mode 2 — open the profile and read its data as your logged-in session |
| `https://www.youtube.com/*`, `https://youtube.com/*`, `https://m.youtube.com/*` | Mode 3 — open the channel and read its data as your logged-in session |
| `https://www.linkedin.com/*`, `https://linkedin.com/*` | Mode 4 — open the search and read the results as your logged-in session |
| `https://www.apollo.io/*`, `https://apollo.io/*` | Mode 7 — open a company's public Apollo page when you ask for it |
| `<all_urls>` (**optional**) | Mode 7 — read a brand's *own* website, the registry directors table, and the lead-database pages. Optional on purpose: Chrome only asks when you press Start in that mode, and the Google half works without it |

> After adding a new host permission, Chrome may show the extension as needing
> re-enabling on the `chrome://extensions` card the first time. Toggle it off and
> on if a mode does nothing at all.

---

## Mode 1 — Google handles

1. Click the toolbar icon to open the side panel.
2. **Cities** — type or paste city names, one per line. You can also paste a
   comma-separated list (`lucknow,kanpur,agra`) — it auto-converts to one
   city per line.
3. **Max pages / city** — how many Google result pages to walk per city
   (1–50). Each page is ~10 results. Default is `3`.
4. **Delay between pages (s)** — wait time between page loads (min 5,
   default `10`). Lower delay = faster but more likely to trigger a CAPTCHA.
5. Click **Start**. A new tab opens and starts walking through
   `site:instagram.com "<city>"` results, page by page, city by city.
6. Watch the **live status/log** in the side panel — current city, current page,
   and how many new handles were found on each page.
7. Click **Download JSON** any time (even mid-run) to save whatever has been
   collected so far.

### If a CAPTCHA/block shows up

- The run **pauses automatically** and you'll get a **desktop notification**
  ("Insta Handle Finder — Paused"). Clicking the notification brings the
  driven tab to the front.
- Solve the CAPTCHA yourself in that tab.
- Come back to the side panel and click **Resume** — it re-loads the same page it
  paused on and continues from there.
- The run only ever moves forward when you click Resume — there's no
  automatic retry.

### Reset

The **Reset** button clears the current run's results, log, and settings
back to defaults. It asks for confirmation first since this is not
reversible — **download your JSON before resetting** if you want to keep it.

### Output format

```json
{
  "generated_at": "2026-08-18T12:00:00.000Z",
  "query_template": "site:instagram.com \"<city>\"",
  "max_pages_per_city": 3,
  "delay_seconds": 10,
  "status": "done",
  "total_handles": 23,
  "cities": {
    "lucknow": [
      { "handle": "@nowlucknow", "profile_url": "https://www.instagram.com/nowlucknow/" }
    ],
    "kanpur": [ ... ]
  }
}
```

- Handles are deduped **globally** — if the same handle shows up for two
  different cities, it's only kept under whichever city found it first.
- Only URLs shaped like `instagram.com/<single-segment-handle>/` are kept —
  posts, reels, stories, explore, and similar non-profile links are filtered
  out.

### Good to know / limits

- **No early exit**: every city runs through its full "Max pages" setting,
  even if some pages turn up zero new handles. Deep page counts (30–50) can
  take a while — each page waits `delaySec` seconds, plus a longer pause
  when moving to the next city.
- **Nothing is evaded**: the extension uses your real logged-in browser tab
  as-is — no proxies, no spoofed headers, no hidden/parallel tabs, no
  CAPTCHA automation. This keeps it simple but means it's still subject to
  normal Google rate-limiting.
- **Progress survives side panel close**: closing the side panel doesn't stop
  the run; it keeps going in the driven tab. Reopen the panel any time to see
  where it's at.
- **Progress survives browser restart... partially**: if Chrome restarts
  mid-run, the run stops (status becomes "Stopped") but whatever was
  collected up to that point is preserved — just click Start again or
  Download.
- Closing the driven tab manually also stops the run (results are kept).

---

## Mode 2 — Instagram profiles (full profile + all posts)

Paste one or more **public Instagram profile URLs or handles** and it opens each
one in a tab, pulls the profile plus its posts, and downloads one JSON file per
account named after the handle (`natgeo.json`). With several accounts, the files
arrive one by one as each account finishes.

**Posts per account** decides how far it goes: a number stops at that many most
recent posts, `MAX` pages to the end of the account.

### How to use it

1. Log into instagram.com in the same Chrome profile. These endpoints usually
   return `401` for a logged-out browser, so the run would just pause asking you
   to log in.
2. Switch the side panel to **Instagram profiles**.
3. **Accounts** — one per line. All of these work and mean the same thing:
   `https://www.instagram.com/natgeo/`, `www.instagram.com/natgeo`, `@natgeo`,
   `natgeo`, and URLs with tracking junk like `?igsh=...`. Post, reel, story,
   explore and `/tagged/` links are rejected — you'll be told how many lines were
   skipped before anything starts.
4. **Posts per account** (default `MAX`). Type a number — `50` — to stop after
   the 50 most recent posts of *every* handle in the list, or leave it as `MAX`
   to page to the end. A number is a real stopping point, not a filter applied
   afterwards: once the budget is spent, no further page is requested. A file
   that stopped at your number is still `"complete": true` — you asked for that
   many and got them — and records the budget as `post_limit`.
5. **Delay between pages** (default 3s, min 2) and **Delay between accounts**
   (default 8s, min 3). Lower = faster and more likely to hit a rate limit.
6. Click **Start**. Watch the live status: which account, which page, how many
   posts so far, and a running list of finished accounts.
7. Each account's file downloads automatically the moment it completes — the
   side panel does not have to stay open.

A **Resume** picks the budget up where it left off — it counts what the account
has already banked, so a run stopped at 30 of 50 asks for 20 more, not 50.

### When it pauses

Same posture as mode 1: **it pauses, it never evades and it never retries in a
loop.** You get a red `⏸` badge and a sticky desktop notification (click it to
jump to the tab). The panel tells you exactly what happened and what to do:

| What happened | What you do |
|---|---|
| Rate limit (429) | Wait — **Resume** is disabled with a live countdown, then enabled. Backoff doubles per consecutive hit, capped at 15 min. |
| Not logged in (401) | Log into Instagram in that tab, then **Resume**. |
| Blocked (403) / checkpoint | Clear it in the tab, then **Resume**. |
| Network dropped | Check your connection, then **Resume**. |
| Instagram changed its API | All post fallbacks failed — the extension needs updating. |
| No profile source worked | Every profile source failed (`profile_unavailable`). Check the driven tab: if the profile itself does not render there, it is a block rather than an API change. |
| Tab closed / browser restarted | **Resume** re-opens the tab and carries on. |

**Resume always continues from the saved cursor**, so nothing is re-downloaded
and nothing is lost. Two cases are handled without pausing at all: a **private**
account you don't follow gets a profile-only file and the run moves on, and a
**handle that doesn't exist** is simply skipped.

### Output format — `<handle>.json`

```json
{
  "handle": "natgeo",
  "profile_url": "https://www.instagram.com/natgeo/",
  "fetched_at": "2026-08-21T12:00:00.000Z",
  "source": "web_profile_info+feed_api",
  "complete": true,
  "incomplete_reason": null,
  "profile": {
    "user_id": "787132",
    "username": "natgeo",
    "full_name": "National Geographic",
    "biography": "...",
    "external_url": "http://natgeo.com",
    "is_private": false,
    "is_verified": true,
    "is_business": true,
    "category": "Media/News Company",
    "followers": 280000000,
    "following": 150,
    "posts_count": 30000,
    "profile_pic_url": "https://...",
    "profile_pic_url_hd": "https://..."
  },
  "posts_count_reported": 30000,
  "posts_collected": 30000,
  "posts": [
    {
      "id": "3123456789012345678",
      "shortcode": "C1a2b3c4d5",
      "url": "https://www.instagram.com/p/C1a2b3c4d5/",
      "taken_at": "2026-08-01T09:15:00.000Z",
      "media_type": "carousel",
      "is_video": false,
      "caption": "...",
      "like_count": 12345,
      "comment_count": 678,
      "view_count": null,
      "display_url": "https://...",
      "video_url": null,
      "carousel_media": [
        { "media_type": "image", "display_url": "https://...", "video_url": null }
      ],
      "location": { "name": "Delhi", "pk": "42" },
      "tagged_users": ["someone"]
    }
  ]
}
```

- **`complete`** is `true` only when the account was paged all the way to the
  end. Anything else sets it to `false` and fills in `incomplete_reason`
  (`private`, `capped`, `partial: rate_limit`, ...) — a partial file never
  pretends to be a full one.
- **`source`** records which endpoints produced the data, so you can tell a
  clean run from one that fell back.
- **Posts are deduped by id** when the file is assembled, so an overlapping page
  after a resume can never produce a duplicate.
- **`comment_count` is the number, not the comments.** Fetching the actual
  comment threads would mean one extra request per post (and those are paginated
  too) — hours of requests and a near-certain block.
- **Media URLs are links, not files.** Nothing is downloaded except the JSON.
  Note that Instagram's CDN URLs expire after a few days, so archive the media
  yourself if you need it long-term.

### Good to know / limits

- **Nothing is evaded.** It uses your own logged-in tab, your own cookies, no
  proxies, no spoofed headers, no parallel hidden tabs, no captcha solving.
  Heavy scraping on your own account can still earn you a rate limit or an
  action block — that's why the default delays are conservative.
- **Instagram's data endpoints are undocumented and change.** Both halves of the
  job fall back rather than fail:
  - *Profile* — `web_profile_info`, retried under each known web app id, then
    `users/<id>/info/` (the id comes from the page's own embedded JSON, or from
    the search endpoint), then the rendered page's `og:` tags. Whichever source
    answered is stamped on the saved profile as `profile_source`, and anything
    that source cannot supply stays `null` rather than being guessed.
  - *Posts* — the feed API, then GraphQL, then a DOM scroll harvest (which
    yields only shortcodes, tagged `"source": "dom"`).

  One known case this covers: Instagram's own serialiser answers
  `web_profile_info` with **HTTP 400 — "Asset
  asset://laser.provider/ig_business_category_subvertical has been deleted. You
  cannot use this schema"** for many business accounts. Nothing is blocked, one
  response shape is simply broken, so the run now moves to the next source
  instead of pausing. The endpoint constants live at the top of
  `content-ig-fetch.js` for easy updating.
- **Hard cap of 500 pages** (~16k posts) per account as a runaway guard. Hitting
  it is reported in the log and marks the file `complete: false` — it is never a
  silent truncation.
- **Progress survives a sleeping service worker.** The paging loop runs in the
  page itself, and every page is persisted, so an MV3 worker shutdown mid-crawl
  costs nothing.
- **Download partial** grabs whatever the current account has so far, at any
  point, without disturbing the run.
- **Reset** clears the Instagram run's collected data and stored pages. Files
  already downloaded are untouched.

---

## Mode 3 — YouTube channels (full profile + all videos)

Same shape as mode 2, pointed at YouTube. You give it channels, it gives you one
`<handle>.json` per channel containing the channel's profile and every video it
publishes — regular uploads and past live streams. Shorts are deliberately skipped.

### How to use it

1. Log into YouTube in this Chrome profile (not strictly required for public
   channels, but a logged-out session hits walls sooner).
2. Open the side panel, switch to the **YouTube channels** tab.
3. Paste channels, one per line. All of these work:

   ```
   https://www.youtube.com/@mkbhd
   https://www.youtube.com/@mkbhd/videos
   @NASA
   mkbhd
   https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ
   https://www.youtube.com/c/SomeOldChannel
   https://www.youtube.com/user/SomeOldUser
   ```

   Video, Shorts-video, playlist and search links are **rejected** — the panel
   tells you how many lines it skipped before it starts.
4. Set the delays. Defaults are 3 s between listing pages, 8 s between channels,
   700 ms between videos.
5. **Full video details** (on by default) is the important switch — see below.
6. **Start**. A tab opens on the first channel and works through it.

### The details switch

The channel listing only carries cheap fields: url, title, thumbnail, a rounded
view count ("1.2M views"), duration and "2 days ago". **Like count, comment
count, exact view count and the full description do not exist in the listing** —
each one needs its own request per video.

| Details | What you get | Cost |
|---|---|---|
| **On** (default) | Every field, exact view counts, full description | ~1 request per video — a 1,000-video channel takes roughly 20 minutes |
| **Off** | url, title, thumbnail, approximate views, duration, published-ago | One request per ~30 videos — minutes for the same channel |

With details off, `like_count`, `comment_count` and `description` are `null` and
`details_source` is `null`, so a thin file is always self-describing rather than
looking like a channel with zero likes.

### When it pauses

Same stance as the other modes: every wall becomes a resumable pause with a
notification, never a silent failure and never a retry storm.

| Reason | What to do |
|---|---|
| `login_wall` | Log into YouTube in that tab, then **Resume** |
| `consent_wall` | Accept YouTube's cookie consent in that tab, then **Resume** |
| `bot_check` | YouTube asked you to confirm you're not a bot — clear it in the tab, then **Resume** (cool-down applies) |
| `rate_limit` | Wait out the cool-down on the Resume button, then **Resume** |
| `forbidden` / `network` | Wait a bit, check the connection, **Resume** |
| `endpoint_shape` | YouTube changed its layout — see Troubleshooting |

Resume picks up from the exact continuation token and the exact channel tab it
was inside, so nothing is re-crawled. A channel that does not exist is skipped
rather than pausing the whole queue.

### Output format — `<handle>.json`

Deliberately the same envelope as mode 2, with `videos` where that one has
`posts`:

```json
{
  "handle": "@mkbhd",
  "profile_url": "https://www.youtube.com/@mkbhd",
  "fetched_at": "2026-08-22T12:00:00.000Z",
  "source": "browse+browse_continuation",
  "complete": true,
  "incomplete_reason": null,
  "details_enabled": true,
  "profile": {
    "channel_id": "UCBJycsmduvYEL83R_U4JriQ",
    "handle": "@mkbhd",
    "title": "Marques Brownlee",
    "description": "...",
    "canonical_url": "https://www.youtube.com/@mkbhd",
    "subscriber_count": 20300000,
    "subscriber_count_text": "20.3M subscribers",
    "subscriber_count_exact": false,
    "video_count": 1703,
    "video_count_text": "1,703 videos",
    "view_count": 4459442510,
    "view_count_text": "4,459,442,510 views",
    "joined_date": "Joined Mar 21, 2008",
    "country": "United States",
    "keywords": ["tech reviews", "smartphones"],
    "is_verified": true,
    "is_family_safe": true,
    "avatar_url": "https://...",
    "avatars": [{ "url": "https://...", "width": 900, "height": 900 }],
    "banner_url": "https://...",
    "links": [{ "title": "Twitter", "display": "twitter.com/MKBHD", "url": "https://twitter.com/MKBHD" }]
  },
  "videos_count_reported": 1703,
  "videos_collected": 1541,
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "kind": "video",
      "title": "...",
      "description": "full description\nwith line breaks",
      "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      "thumbnails": [{ "url": "https://...", "width": 1280, "height": 720 }],
      "view_count": 1234567,
      "view_count_text": "1,234,567 views",
      "view_count_exact": true,
      "like_count": 34567,
      "comment_count": 2345,
      "published_text": "2 days ago",
      "published_date_text": "Jan 5, 2024",
      "published_at": "2024-01-05T00:00:00.000Z",
      "duration_text": "12:34",
      "duration_seconds": 754,
      "is_live_now": false,
      "live_viewers": null,
      "details_source": "next",
      "details_error": null
    }
  ]
}
```

- **`kind`** is `video` or `live` — the Videos and Live tabs are crawled in that order
  into one list, deduped by id (a past stream can appear in both). **Shorts are not
  collected at all** — the Shorts tab is never requested, and a Shorts shelf appearing
  inside another tab is skipped rather than mapped.
- **`videos_count_reported` is YouTube's own channel total**, which counts Shorts. Since
  Shorts are not collected, `videos_collected` is normally lower — that gap is expected
  and does not make the file incomplete.
- **`comment_count` is a plain number** (or `null` if comments are off/unreadable). No
  comment text, authors or threads are fetched — only the count YouTube itself displays.
- **`view_count_exact`** tells you whether the number is YouTube's exact figure
  or its rounded "1.2M". With details on it is exact; with details off it is not.
- **`details_source`** is `next` (or `next+player`) for an enriched video and
  `null` for one that was never enriched; `details_error` says why a single
  video could not be read (removed, private, age-gated) without failing the run.
- **`subscriber_count`** is parsed from YouTube's own rounded text — YouTube
  itself does not publish an exact subscriber number any more, hence
  `subscriber_count_exact: false`.
- **A stream that is live right now** reports watchers, not views, in the same field —
  those land in `live_viewers` with `is_live_now: true`, and `view_count` stays null
  rather than being quietly understated.
- **A count YouTube writes in a form the parser cannot trust becomes `null`**, never a
  guess; the raw string is always kept alongside in the matching `*_text` field.
- **Thumbnail URLs are links, not files.** Nothing is downloaded except the JSON.

### Good to know / limits

- **Nothing is evaded.** It calls YouTube's own InnerTube endpoints from your own
  logged-in tab with the page's own client identity — no proxies, no spoofed
  user-agent, no hidden parallel tabs, no bot-check solving.
- **Requests ask for English labels** (`hl=en`, region left alone). Every count YouTube
  ships is a *string*, and separator rules differ per language — a German
  "1,2 Mio. Aufrufe" cannot be read without guessing. The channel profile is fetched
  through that same English request rather than scraped off the rendered page.
- **The InnerTube API is undocumented and changes.** Every field is located by
  key rather than by a fixed path, so a renamed wrapper does not break the crawl;
  a renamed *field* becomes `null` rather than a crash. The endpoint constants
  and channel-tab `params` live at the top of `content-yt-fetch.js`.
- **Hard cap of 500 pages** (~15k videos) per channel as a runaway guard, same as
  mode 2 — reported in the log and marked `complete: false`.
- **Progress survives a sleeping service worker.** The paging loop runs in the
  page itself and every page is persisted.
- **Download partial** and **Reset** behave exactly as in mode 2.

---

## Mode 4 — LinkedIn posts (from a search URL)

You give it a LinkedIn **search results** URL; it scrolls the result list to the end and
writes every post it saw to one `linkedin-<keywords>.json`.

### How to use it

1. Log into LinkedIn in this Chrome profile.
2. Search on LinkedIn, then click the **Posts** tab, and copy the URL from the address bar.
   It looks like:

   ```
   https://www.linkedin.com/search/results/content/?keywords=ai%20startup
   ```

   Any filters you set on that page (date posted, sort order, author) are part of the URL,
   so whatever the page shows is what gets exported.
3. Open the side panel, switch to the **LinkedIn posts** tab, and paste the URL — one per
   line if you want several searches in a row.

   Also accepted: `/search/results/all/?keywords=…` (rewritten to the Posts tab, since
   the "all" tab only ever shows a few posts) and hashtag feeds like
   `/feed/hashtag/saas`. Profile, job-search and single-post links are **rejected** — the
   panel tells you how many lines it skipped before it starts.
4. Set the limits. Defaults are 3 s between scrolls, 10 s between searches, and **300 posts
   per search** (set it to `0` for no limit).
5. **Start**. A tab opens on the search and scrolls until LinkedIn stops adding results.

### How it reads the page

Unlike modes 2 and 3, this one reads the **rendered page** rather than a private JSON API.
That is deliberate: LinkedIn's internal endpoints are gated behind ids that rotate
constantly, while search results are an infinite scroll — scrolling is the native way to
page through them, and the DOM is what you are already looking at.

Posts are located three ways, in order, so a redesign has to break all four to stop the
run:

1. **By activity id** — every element whose attributes or link `href` carry a post id, in
   either spelling LinkedIn uses: `urn:li:activity:123…` and the `…-activity-123…-AbCd`
   segment inside a `/posts/` permalink. This runs first because it is the only method that
   can see nesting: when a reshare's quoted post has an id and the outer card does not, a
   plain selector would return the quoted post.
2. **By selector** — the known wrapper class names, for speed on a familiar layout.
3. **By structure** — the smallest element holding both an author block and a post body.
4. **By repeated siblings** — the element whose children are all post-shaped, taken as the
   result list. This needs no class name, no id and no attribute, and is what carries the
   run on builds where LinkedIn ships hashed class names like `_8f294d25`.

If all four come back empty, the run reports `no posts found` and the log dumps the shape
of the results list (its class, its child count, the child's `data-` attributes, and whether
a urn appears in the HTML at all) — which is what the next one-line fix is made from.

Two consequences worth knowing:

- **Truncated posts are expanded first.** LinkedIn only renders the first ~200 characters
  until "…see more" is clicked, so each round clicks those open before reading, and `text`
  is the full post rather than a preview.
- **A reshare is one row, not two.** The quoted post nested inside it is skipped, and the
  outer post is flagged `is_repost: true`.

### When it pauses

Same stance as every other mode: each wall becomes a resumable pause with a notification.

| Reason | What to do |
|---|---|
| `login_wall` | Log into LinkedIn in that tab, then **Resume** |
| `challenge` | Clear LinkedIn's verification in that tab, then **Resume** |
| `rate_limit` | LinkedIn's search limit. The cool-down starts at 5 minutes and doubles up to an hour — wait it out, then **Resume** |
| `wrong_origin` | LinkedIn bounced the tab elsewhere; **Resume** re-opens the search |

Resume re-opens the search and skips everything already banked, so a resumed pass only
adds what it did not already have.

### Output format — `linkedin-<keywords>.json`

```json
{
  "search_label": "creator requirements",
  "search_url": "https://www.linkedin.com/search/results/content/?keywords=creator%20requirements",
  "fetched_at": "2026-08-22T12:00:00.000Z",
  "source": "dom",
  "complete": true,
  "incomplete_reason": null,
  "max_posts": 300,
  "scroll_rounds": 27,
  "posts_collected": 268,
  "posts": [
    {
      "author": {
        "name": "Vivek Mehta",
        "profile_url": "https://www.linkedin.com/in/vivek-mehta-89b38b415/",
        "type": "person",
        "discription": "CEO & Founder @ The Hidden Fox Co. | D2C, Influencer & Healthcare Marketing"
      },
      "posted_text": "3w •",
      "text": "Looking for 7 Nano Tech Creators.\nRequirements:\n• 1K–10K followers"
    }
  ]
}
```

- **`discription`** is the line LinkedIn shows directly under the author's name — their
  profile headline. (Spelled as requested; renaming it to `description` is a one-line
  change in `slimPost()`.)
- **`author.type`** is `person`, `company` or `school`, taken from the profile URL.
- **`text` keeps its line breaks.** Truncated posts are expanded before reading, so this
  is the whole post and not the "…see more" preview.
- **Anything unreadable is `null`, never guessed.** A headline is never borrowed from a
  neighbouring card, and a card with no headline gets `null`.
- **The scraper collects more than it exports.** Post ids, reaction/comment counts, media
  URLs and permalinks are gathered and used internally — the id in particular is what
  dedupes a post across scrolls and resumes — but the file stays narrow on purpose.
  `slimPost()` in `background-linkedin.js` is the single place that decides the shape;
  widening it back is one line per field.

### Good to know / limits

- **Nothing is evaded.** It scrolls the user's own logged-in tab, exactly as a person
  would. No proxies, no spoofed user-agent, no hidden tabs, no auth-wall bypass.
- **LinkedIn caps search results.** A content search stops producing new results well
  before the total it claims; the run ends when scrolling stops adding posts, which is the
  real end of what LinkedIn will serve.
- **LinkedIn's terms restrict automated collection**, and posts are personal data — keep
  the exports to what you actually need, and to what you are allowed to hold.
- **Markup changes are visible, not silent.** If a redesign defeats all four strategies,
  the run reports `no_results` with the shape of the page, and the fix is one entry in
  `POST_SELECTORS` at the top of `content-li-fetch.js`.
- **A post with no urn is still exported**, with a content-derived `id` so it still dedupes.
  Losing a permalink beats losing the post.

---

## Mode 5 — Instagram discovery (creator handles)

Mode 1 finds Instagram accounts by asking Google. That works badly for creators:
a `site:instagram.com "<city>"` query carries no creator signal, most of the
results are `/p/` and `/reel/` links that get thrown away, and Google collapses
`site:` results long before you have a useful list.

This mode asks Instagram instead. Given one creator you already like, Instagram
itself will tell you who is similar — that is a breadth-first walk of its own
suggestion graph, and it is what this mode does.

Output is a **candidate list**, not profiles. The profile exporter (mode 2)
already does that job properly; discovery hands it a ranked queue.

### How to use it

1. Log into Instagram in Chrome, as normal.
2. **IG discovery** tab → put seeds in the box, one per line. Three forms, and
   the rule between them is deliberately unambiguous:

   | Seed | Means |
   |---|---|
   | `@somecreator` or `instagram.com/somecreator` | walk that account's similar-accounts graph |
   | `#delhifashionblogger` | harvest the accounts posting under that hashtag |
   | `mumbai food blogger` | Instagram search for that phrase |

   A bare word with no prefix is always a **search term**, never a handle —
   `mumbaifoodblogger` is far more often a phrase somebody typed than an account
   they meant.
3. Set the follower band you actually want (default 1K–1M, the micro/mid
   influencer window), depth, and the caps.
4. Optionally switch on **Sirf Indian creators** and/or **Raat bhar mode** — both
   have their own sections below. **Start**.
5. When it finishes, `ig-discovery_<date>.json` downloads by itself. **Handles
   copy** puts one of three lists on the clipboard — pick which with the dropdown
   beside it — and you paste that into the **Instagram profiles** tab to export
   them properly.

Depth 0 means "only the seeds". Depth 2 (the default) means seeds → their similar
accounts → *their* similar accounts. Each level multiplies the request count, so
3 is the hard ceiling.

### The detail switch

Discovery listings answer thin: usually a handle, a name, private/verified, and
often nothing else. With **detail** on (the default), every kept candidate gets
one extra request that fills in follower count, category and bio — the three
signals the score leans on hardest. It roughly doubles the run length and is
capped at 400 candidates, reported when it bites.

With it off the run is much faster, and most scores come back `?`. That is not a
low score — see below.

**If you want "2K+ followers" or "Indian creators", leave this on.** Both of
those filters need data only this pass fetches — a follower count, a bio, a city.
Without it the run still works, it just cannot confirm either, so both of the
narrow lists come back empty. The panel asks before starting a run that has one
of those switches on and detail off.

### Sirf Indian creators

Off by default. It is a **delivery-side** filter: it changes which handles the
run hands over at the end, and nothing else. It never gates `keep` and it never
gates the walk — most listing records carry no bio, no city and no phone, so
requiring India evidence to chain from an account would collapse the frontier on
the very first hop. Geography comes from your seeds; this decides the output.

An account is called Indian only on **positive evidence**:

| Signal | Strength | Where it comes from |
|---|---|---|
| `phone_country_code` is 91 | strong | `/info/` business record |
| `city_name` is an Indian city/state | strong | `/info/` business record |
| `+91 …` number in the bio | strong | bio |
| Devanagari / Bengali / Tamil / Telugu / Gujarati / Gurmukhi / Kannada / Malayalam / Odia text | strong | bio or display name |
| "India" / "Indian" / "Bharat" / "desi" in the bio | strong | bio |
| An Indian city or state named in the bio | strong | bio |
| ₹ / "Rs 5000" / "INR" in the bio | weak | bio |
| Link on a `.in` domain | weak | `external_url` |

One strong signal is enough; two weak ones together are enough; one weak one on
its own is not. Whichever fired is written into the row as `india_signals`, so
the verdict can be argued with instead of taken on faith.

**Absence is never a "no".** An account with nothing to go on is `"unknown"`, not
"not Indian" — it stays in the file in full and simply is not in the India list.
The same null rule the score uses, for the same reason.

**Names are deliberately not a signal.** Guessing somebody's nationality from
their name is unreliable and gets individual people wrong, and this list ends up
in someone's outreach — there is a real person on the other end of a bad guess.

A few place names exist outside India too (there is a Hyderabad in Pakistan,
Punjab spans the border), so a place match is evidence rather than proof. That is
why every signal is recorded.

### Raat bhar mode (unattended runs)

Off by default, and it is the **one** place this project relaxes its "a run waits
for a human" stance. Switch it on, say how many hours, and the run supervises
itself:

| What happens | What the run does |
|---|---|
| The hours you set run out | Saves the file and stops. The file only exists once a run finishes, so without this a run still going at 7am has produced nothing. |
| **Rate limit (429)** | Waits out the **full** backoff, then resumes itself. Max 4 times a night. |
| Login wall (401), 403, checkpoint | **Nothing.** Sits there until you deal with it. |
| Tab closed, or discarded by Chrome | Re-opens it, re-queues the tasks that had not reported, carries on. Max 20 times. |
| Batch goes silent (crashed page, discarded tab) | Same recovery, on a 2-minute watchdog. |

The line between the second row and the third is the whole point. Waiting out a
rate limit is what you would have done yourself; it is patience, not evasion.
Clicking past a checkpoint would be working around a block, so it is not done —
awake or asleep.

Practical setup, none of which the extension can do for you:

- **Laptop plugged in, system sleep off** (display off is fine). Chrome is fully
  suspended while Windows sleeps and alarms do not fire.
- **`chrome://settings/performance` → let instagram.com be an exception** to
  Memory Saver, so Chrome does not discard the tab under you. The watchdog
  recovers from a discard, but not having one is better.
- **Slow the pacing down.** The defaults (4s / 10s) are tuned for a run you are
  watching. For hours unattended, 20-30s between requests and 180-300s between
  batches keeps it near 60-110 requests/hour, which is a very different load on
  one account than the default is.

**Be honest with yourself about the risk.** Hours of continuous private-API calls
from one personal logged-in account is the heaviest thing this tool can do, and
overnight activity is its own signal. The realistic outcomes are escalating
429s, then a temporary action block, then a checkpoint you have to clear. Do not
do this from an account you cannot afford to have restricted. Two or three
shorter evening runs on different seeds get you the same coverage for a fraction
of the exposure.

### How a candidate is scored

The score is a percentage of the evidence that **actually existed**, not of every
signal that could have existed:

| Signal | Weight | Best case |
|---|---|---|
| Follower band | 35 | inside the band you set |
| Private account | 20 | public |
| Category | 20 | matches creator words (creator, blogger, artist, photographer…) |
| Follower/following ratio | 15 | ≥ 3 |
| Bio intent | 15 | collab wording or a contact email |
| Posts count | 10 | 20+ |
| Verified | 10 | verified (unverified keeps most of the credit — it is normal for a micro creator) |
| Bio link | 10 | present |

**A signal the source did not supply is left out of the sum entirely** — it
neither helps nor hurts. So a candidate nobody could measure scores `null`,
shown in the panel as `?`, and it is kept rather than dropped: a terse listing is
not evidence against an account. Scoring a missing follower count as zero would
bury every account a listing happened to be short about; scoring it as average
would promote them over accounts that were actually measured. Neither is honest.

Private accounts are the one hard drop — nothing about them can be exported later
— but they are still saved in the file, flagged, rather than being thrown away.

### Output format — `ig-discovery_<date>.json`

```jsonc
{
  "generated_at": "2026-08-31T09:12:03.114Z",
  "complete": true,
  "incomplete_reason": null,
  "seeds": ["mumbai food blogger", "@somecreator"],
  "settings": {
    "max_depth": 2,
    "max_candidates": 500,
    "follower_band": [1000, 1000000],
    "keep_threshold": 50,
    "chaining_enabled": true,
    "enrich_enabled": true,
    "excluded_handles": 0,
    "india_only": true,
    "unattended": true
  },
  "runaway_guard_hit": null,          // or "max_candidates" / "max_tasks"
  "sources_disabled": [],             // sources that stopped answering mid-run
  "totals": { "tasksDone": 41, "tasksPlanned": 41, "candidates": 380, "kept": 233 },
  "candidates": [
    {
      "handle": "somefoodie",
      "profile_url": "https://www.instagram.com/somefoodie/",
      "user_id": "1234567890",
      "full_name": "Some Foodie",
      "biography": "DM for collabs",
      "followers": 48200,
      "following": 310,
      "posts_count": 412,
      "is_private": false,
      "is_verified": false,
      "is_business": true,
      "category": "Digital creator",
      "external_url": "https://linktr.ee/somefoodie",
      "city_name": "Mumbai",          // /info/ only, and only if they filled it in
      "phone_country_code": "91",     // the code only — never the number itself
      "score": 86,                    // null means "not enough evidence", never 0
      "score_known_weight": 125,      // how much evidence that score is based on
      "signals": { "followers": "in_band", "ratio": "high", "category": "creator" },
      "india": "yes",                 // "yes" or "unknown" — never "no"
      "india_signals": ["city", "bio_place"],   // why it was called Indian
      "keep": true,
      "enriched": true,
      "found_via": "@somecreator",    // which seed/step surfaced it
      "found_kind": "chain",
      "depth": 1
    }
  ],
  "kept_handles": ["somefoodie", "..."],           // paste-ready for mode 2
  "in_band_handles": ["somefoodie", "..."],        // kept AND measured AND inside the band
  "india_in_band_handles": ["somefoodie", "..."]   // ...AND evidence of being Indian
}
```

`candidates` is sorted best-first. Unrated candidates sort below rated ones —
they are unmeasured, not rejected.

**`kept_handles` vs `in_band_handles`.** They answer different questions and the
gap between them is the useful part. `keep` is generous on purpose: an account
nobody could measure is not evidence against itself, so it stays. That means
`kept_handles` contains accounts with no follower count at all, and accounts the
other signals carried over the threshold from just outside the band.

`in_band_handles` is the stricter list — kept, **and** it has a real
`follower_count`, **and** that number is inside the band you set. It is the only
one of the two you can honestly call "the accounts in my follower range".

It comes back short, or empty, when the **detail switch was off** — without that
pass almost nothing has a follower count to check, so there is nothing to confirm
against the band. That is the true answer, not a fault. Nothing is dropped from
the file either way: every candidate is still in `candidates`, with its
`followers` either a number or `null`.

`india_in_band_handles` narrows it once more: everything `in_band_handles` asks
for, plus positive evidence of being Indian. It is the list an overnight India
run exists to produce.

The three are nested — every handle in the India list is in the band list, and
every handle in the band list is in the kept list. The panel's finish line reports
all three counts so you can see the gaps without opening the file, and the
dropdown beside **Handles copy** chooses which one goes to the clipboard.

### When it pauses

Same stance as every other mode: a wall pauses the run, it is never retried
around. **Resume** repeats exactly the tasks that had not reported yet and none
of the ones that had.

| Reason | What to do |
|---|---|
| Not logged in (401) | Check the tab. If you *are* logged in, this is a temporary API block — wait 10-15 min, then **Resume**. |
| Rate limit (429) | Wait out the cool-down the panel counts down, then **Resume**. |
| Blocked (403) / checkpoint | Clear it in the tab, then **Resume**. |
| Tab closed | **Resume** re-opens it and carries on from the same frontier. |

**The one documented exception** is *raat bhar* mode, and only for the rate limit
row: with it on, that pause resumes itself once the full backoff has elapsed, up
to four times a night, and a closed or discarded tab is re-opened. Every other row
in the table still waits for you, awake or asleep. See the section above.

### Good to know / limits

- **The discovery endpoints are undocumented and unverified.** Only the search
  endpoint is one this extension already used elsewhere. If a source starts
  answering nonsense it is switched off **for that run** after two consecutive
  structural failures and the remaining sources carry on — the log and the output
  file both name what was disabled. A dead endpoint is never re-tried once per
  frontier node; that would be exactly the request storm this project refuses to
  make. The constants live together at the top of `content-ig-discover.js`.
- **A wall is not a dead source.** A login/rate-limit/checkpoint failure stops the
  whole batch instead of disabling one source, because every source would hit the
  same wall.
- **Runaway guards**: 500 candidates by default (5000 max), 2000 frontier tasks,
  400 enrichment requests. All three are reported in the log and written into the
  file as `runaway_guard_hit` — never a silent truncation.
- **A runaway guard stops the walk, not the run.** When the candidate or task cap
  bites, the discovery tasks still queued are dropped — they could only surface
  candidates there is no room to store — but the **detail pass still runs**.
  Finishing at the cap would hand back a file where almost nothing has a follower
  count, which would make both `in_band_handles` and `india_in_band_handles`
  empty for a run that had actually found plenty.
- **The detail cap is what limits "confirmed" results, not the clock.** Only
  enriched candidates have a follower count, and that pass is capped at 400 per
  run. However long a run goes, at most 400 accounts come back *measured* — so a
  long night's realistic yield is a few hundred confirmed handles, not thousands.
  Repeat runs on different seeds, with the previous night's handles pasted into
  **Exclude handles**, is how you get past that.
- **Only plausible creators grow the frontier.** A candidate that scores below the
  keep threshold, or is private, is stored but never chained from — otherwise one
  bad seed drags the whole walk into a neighbourhood you did not ask for.
- **One tab, parked on instagram.com.** Discovery never needs a particular profile
  open — every source is an API call the app itself makes while you browse — so
  there is no per-candidate navigation.
- **Nothing is auto-fed into mode 2.** Copy the handles across yourself; a heavy
  profile crawl should not start without you watching it.

---

## Mode 6 — Brief → creators (one brief, one folder)

Modes 5 and 2 are the two halves of the job an influencer-marketing brief
actually asks for: find creators who fit it, then pull their recent work so
somebody can judge them. This mode wires those halves together and adds the two
pieces in between — reading the brief, and picking the N it hands over.

Paste the brief, say how many creators you want, press **Start**. It discovers,
selects, exports, and everything lands in one folder under Downloads.

### How to use it

1. Log into instagram.com in the same Chrome profile.
2. **Brief → creators** tab → paste the brief into the box, or pick a
   `.txt` / `.md` / `.csv` / `.json` file. **PDF and Word are not read** — copy
   the text out and paste it. There is no document parser here, and one that
   silently produced half a brief would be worse than none.
3. **Brief padho**. It reads the brief and shows what it understood — brand,
   niches, cities, follower band, creator count, languages, brand handles — plus
   the **seeds** it built from that.
4. **Check the seeds.** They are an ordinary editable textarea and they are the
   whole input to discovery. Delete the ones that miss the point, add your own.
5. Set **Kitne creator chahiye** (N) and **Posts per creator** (default 10, or
   `MAX`), then **Start** and confirm the size of the crawl.

### How the brief is read

There is no LLM involved. The reader uses the structure real briefs already have
— `Niche / Genre:`, `Tier:`, `Location:`, `Number of Creators:` — and reads each
field out of *its own section* rather than the whole document. That scoping is
what stops the word "Unboxing" in a deliverables list from turning a gifting
campaign into a tech-creator campaign. A brief with no headings still works: each
field falls back to a whole-document scan, and the panel says which happened.

| Field | How |
|---|---|
| Niches | Keyword vocabulary (wedding, couple, family, fashion, beauty, lifestyle, gifting, food, travel, …) matched inside the niche section |
| Cities | ~50 Indian cities with aliases — Bangalore/Bengaluru, Bombay/Mumbai, Delhi NCR/Delhi — kept **in the order the brief lists them**, because the seed budget is spent front-to-back |
| Follower band | Explicit numbers win (`100K to 500K`); otherwise the tier word's default band. A range on a line that mentions neither followers nor a K/M suffix is ignored, so "Week 1 to 4" is not a band |
| Creator count | The first `N … creators` in the creator-count section |
| Brand handles | `@mentions` and `instagram.com/…` links — added to discovery's **exclude** list, since the brand's own account is a lead for nobody |

Seeds are one per niche (`wedding content creator`), then city × niche pairs
round-robin so the first seeds cover many cities *and* many niches
(`delhi wedding`, `mumbai couple`, `bengaluru family`, …), then any hashtags the
brief contained. Capped at 24 by default.

### How the N are picked

From the discovery candidates, **follower band first, then score**:

1. **In band** (measured, inside the band the brief asked for)
2. **Unmeasured** — no follower count came back. Not evidence of being out of
   band, and not evidence of being in it
3. **Out of band**

Ties break on discovery's keep flag, then its score, then follower count. An
account measured at 5K with a 95 score loses to one measured at 150K with 86,
because the brief asked for a range and that is the request being served.

**Private accounts are never picked** — their posts cannot be exported at all —
but they stay in the shortlist file, flagged, for you to see.

**Gender is not selected for.** Briefs routinely ask for a male/female split;
a profile does not reliably state gender and guessing from a name or a photo is
not something this tool will do. If the brief asks for one, the panel says so and
the ranked shortlist is there for you to pick from by hand. The same goes for
"brand suitability" and content quality — the brief's own last line asks for
human judgement, and this mode hands you the material for it rather than
pretending to have made the call.

### What lands in the folder

`Downloads/brief_<brand>_<date>/`:

| File | What |
|---|---|
| `_brief-plan.json` | The brief text, everything parsed out of it, and the exact discovery settings. Written **before** the first request, so a run that dies on a wall still leaves a record of what it was going to do |
| `ig-discovery_<date>.json` | Discovery's own full candidate file (mode 5's format) |
| `_shortlist.json` | Every candidate, ranked, with `band_fit`, plus which N were picked |
| `<handle>.json` | One per picked creator — profile + the posts, in mode 2's format |
| `_summary.json` | What actually happened per creator: file name, posts exported, complete or not, and why |

### When it pauses

It runs two sub-runs and does not own any of the crawling itself, so a wall shows
up exactly where it did before: discovery pauses, or the export pauses, and this
mode mirrors that up with the same reason and one **Resume** that forwards to
whichever half was running. Everything already downloaded stays downloaded.

One extra case is its own: if the discovery or profile run it is waiting on gets
**replaced by a manual run** from another tab, the brief run pauses and says so
rather than quietly adopting somebody else's results. Sub-runs it starts are
tagged; an untagged one is not its own.

### Good to know / limits

- **It refuses to start on top of a live run** in the IG discovery or Instagram
  profiles tabs — both are single-tab runners, and starting over one would throw
  away what you already had going.
- **Cost is roughly `seeds + candidates + N` Instagram requests**, at the delay
  you set. The confirm dialog before Start states the shape of it. Discovery's
  own runaway guards (500 candidates, 2000 tasks) still apply.
- **The parser is a first draft, never a black box.** Everything it extracted is
  visible and every seed is editable before anything runs.
- **Instagram only.** If the brief is a YouTube brief the panel warns you; the
  YouTube exporter is mode 3 and is not wired into this.

---

## Mode 7 — Brands → contacts

Paste a list of brand names. For each one it builds a row: official website,
public email addresses, phone numbers, social profiles, and the people publicly
described as founder / owner / CEO — with the URL every single claim came from.

It reads **only pages that are already public to a logged-out visitor**: Google
results, the brand's own website, and (if you ask) a LinkedIn or Apollo page. It
does not log in anywhere for you, does not open a paid database, and does not
guess an address from a name pattern. If a page wants a login, that is written
on the row as a note and the run moves on.

### How to use it

1. Open the side panel → **Brands → contacts**.
2. Paste the brands, one per line (commas work too):
   ```
   Mamaearth
   boAt Lifestyle
   Nykaa
   ```
3. Optional **region hint** (`India`) — it joins the Google query, so a same-named
   brand from another country stops showing up.
4. Press **Start**. Chrome asks for site access the first time (see below).

### The five steps per brand

| # | Page it opens | What it takes from it |
|---|---|---|
| 1 | Google `"<brand>" official website contact email` | the official website, social profiles, any contact detail printed in the snippets |
| 2 | Google `site:linkedin.com "<brand>" (founder OR CEO OR owner OR director OR manager)` | decision-maker names + their profile URLs, the LinkedIn company page |
| 3 | Google `(site:apollo.io OR site:rocketreach.co OR site:lusha.com OR site:contactout.com OR site:easyleadz.com OR site:coresignal.com OR ...)` | more names + titles, and the page on each database where the name was read |
| 4 | Google `(site:zaubacorp.com OR site:tofler.in OR site:indiafilings.com OR ...)` | the registry page for the company |
| 5 | the brand's own site — homepage, then its contact/about/team pages | `mailto:`/`tel:` links, schema.org data, footer numbers, **and the number printed inside a person's own card** |
| 6 | the registry page | the **directors table** — the board, by name |
| 7 | *(off by default)* the LinkedIn / lead-database pages themselves | whatever those pages show you while logged in |

**All six people-search databases ride in one Google query, not six.** Asking
them separately would be six searches a brand — sixty for a ten-brand list, and a
CAPTCHA long before the end.

Steps 1-4 are what the directories *say*. Steps 5-6 are what the brand and the
registrar *publish*, and that is where nearly every real number comes from —
which is why they run even when the searches come back empty.

> **What the lead databases actually give you.** Apollo, RocketReach, Lusha,
> ContactOut, EasyLeadz and CoreSignal keep their direct-dial numbers behind a
> login and a paid credit, and their public pages show a masked number
> (`+91 98***10`) that the phone parser correctly refuses. So they are used for
> **who the decision maker is** — name, title, profile link — and the number is
> then looked for on sources that publish one in full. If you want their
> unmasked data, that is their paid API, not a browser extension.

### Site access

Reading a brand's own website means injecting into an arbitrary domain, which
needs Chrome's `<all_urls>` permission. Holding that permanently for a run you
may never do is a bad trade, so it is **optional** and requested from the panel
the first time you press Start.

- **Granted** → all five steps run.
- **Refused** → the run still works, but step 4 is skipped and each affected row
  says `website mila par site-access permission nahi hai`. You will get names and
  URLs, and far fewer emails.
- The **Site access do** button re-asks at any time; granting it mid-run takes
  effect on the very next brand.

### How a website is chosen

Not "the first Google result". A domain that *spells the brand* beats a
higher-ranked one, and platforms (Instagram, Amazon, Wikipedia…) and lead
databases (Apollo, ZoomInfo, IndiaMART, JustDial…) are never treated as the
official site however high they rank. When nothing matched on name, the pick is
still made but the row records that it was a guess.

### How a contact detail earns its place

Every email and phone carries **where it came from** and **how sure we are**:

| Confidence | Comes from |
|---|---|
| `high` | a `mailto:`/`tel:` link, or a schema.org `Organization` block |
| `medium` | plain text on the brand's own page, or a Google snippet for that brand |
| `low` | a number found loose in page text, or in a directory's snippet |

The same address seen twice is one address that we are now surer about, not two
rows. A snippet's details are only accepted when the result is plausibly about
*that* brand (its own domain, or the brand's name in the host or title) — without
that rule, one competitor ranking on the query would put its sales email on your
row.

Phone numbers are the noisy field. A date (`20240115`), a repeated run
(`0000000000`) and a bare 8-digit order id are rejected outright, and anything
found in loose text is marked `low` so a human can tell it apart from a `tel:`
link.

### Owner, not reception

This is the part the mode exists for. A row is not "here are some contacts" — it
is **"here is the decision maker, and here is how to reach them"**.

Only leadership titles are kept — founder, co-founder, owner, proprietor, CEO,
managing director, director, partner, president, chairman, C-level, manager.
Without that filter the searches return every employee whose profile mentions the
brand and the row stops answering "who do I contact". Titles are ranked, so the
founder is the headline and the marketing manager is not.

Names come from four places, and the row says which: a search result title
(`linkedin_snippet`, `rocketreach_snippet`, …), a schema.org `founder` field
(`site_jsonld`), a role word next to a name on an about/team page (`site_text`),
or a registry's directors table (`registry_page_text`).

**How a number becomes *that person's* number.** Three ways, and nothing else:

1. It is inside their own card on the page. The card is walked outward from the
   role word only as long as it stays small (under ~400 characters) — the moment
   the enclosing element holds the whole page, the link between name and number is
   gone and nothing is claimed.
2. The site's own schema.org `Person` block states it.
3. For emails only: the address is *built out of their name* —
   `ravi.sharma@`, `rsharma@`, `ravi@`, `sharma@`. Structural matches only; a
   shared inbox is never claimed even if the name would fit.

Everything else is sorted into three honest buckets:

| Bucket | What it holds |
|---|---|
| `decision_makers[].phones / .emails` | tied to a named person by one of the three rules above |
| `unattributed_personal` | looks personal (a "Mobile:" label, a non-role address) but no name could be attached |
| `company_contacts` | `info@`, `sales@`, reception, toll-free — the company's, not a person's |

`best_contact` is the top of that: one name, one number, one address, one profile
link. When no named person could be reached it is `null` — the mode says so rather
than passing the switchboard off as the owner.

Tick **Sirf owner/director ke contact rakho** and the company bucket is dropped
from the file entirely, replaced by a count of what was left out.

### Board of directors

For an Indian private limited, LinkedIn shows whoever posts and the lead databases
show whoever was scraped — neither is the **board**. The registry sources
(Zauba Corp, Tofler, IndiaFilings, InstaFinancials) publish the directors table
from the MCA filings, which is public record. That is the one source that answers
"board of directors" literally, so its page is opened whenever the toggle is on and
site access is granted — it does not wait for the "open profile pages" option.

Names there are printed in caps; they are title-cased on the way in, both so the
file is readable and so a name-built email can match them.

### When it pauses

Only Google can pause the run — a CAPTCHA, a `/sorry/` redirect, or an
"unusual traffic" page. Solve it in the tab and press **Resume**; it retries the
exact search it stopped on.

A brand's *website* never pauses the run. A site that will not load, will not run
the script, or never finishes loading is noted on the row and stepped over — one
broken site out of fifty should not cost you the other forty-nine.

### Output format — `brands_contacts_<date>.json`

Written automatically when the run finishes, and available any time from
**Download JSON** / **Download CSV**.

```jsonc
{
  "generated_at": "2026-09-01T10:12:00.000Z",
  "region_hint": "India",
  "status": "done",
  "owner_only": false,
  "brands_requested": 3,
  "brands_complete": 3,
  "sources": {
    "google": true,
    "brand_website": true,
    "linkedin_search": true,
    "lead_databases": ["apollo.io", "rocketreach.co", "lusha.com", "contactout.com",
                       "easyleadz.com", "coresignal.com", "zoominfo.com", "signalhire.com"],
    "company_registries": ["zaubacorp.com", "tofler.in", "indiafilings.com", "instafinancials.com"],
    "profile_pages_opened": false
  },
  "rows": [
    {
      "brand": "Acme Foods",
      "website": "https://acme.com/",

      // The answer, if there is one. null when nobody named could be reached.
      "best_contact": {
        "name": "Ravi Sharma",
        "title": "Founder",
        "phone": "+919812345678",
        "email": "ravi.sharma@acme.com",
        "profile": "https://in.linkedin.com/in/ravi-sharma",
        "source": "linkedin_snippet"
      },

      "decision_makers": [
        {
          "name": "Ravi Sharma", "title": "Founder", "confidence": "medium",
          "url": "https://in.linkedin.com/in/ravi-sharma", "source": "linkedin_snippet",
          "phones": [ { "value": "+919812345678", "label": "direct", "confidence": "high",
                        "how": "person_card_tel", "source_url": "https://acme.com/team" } ],
          "emails": [ { "value": "ravi.sharma@acme.com", "confidence": "high",
                        "how": "mailto+name_match", "source_url": "https://acme.com/team" } ]
        },
        { "name": "Anita Desai", "title": "Managing Director", "source": "registry_page_text",
          "confidence": "low", "phones": [], "emails": [] }
      ],

      // Looks personal, but no name could be attached to it.
      "unattributed_personal": { "emails": [], "phones": [
        { "value": "+919876543210", "label": "mobile", "confidence": "high", "how": "tel" } ] },

      // Dropped entirely when owner_only is on, replaced by company_contacts_dropped: <n>
      "company_contacts": {
        "emails": [ { "value": "info@acme.com", "confidence": "high", "how": "mailto" } ],
        "phones": [ { "value": "+911140001234", "label": "reception", "confidence": "high" } ]
      },

      "socials": { "instagram": "https://www.instagram.com/acmefoods/" },
      "linkedin_company": "https://www.linkedin.com/company/acme-foods",
      "apollo_url": null,
      "lead_db_pages": [ { "host": "rocketreach.co", "url": "https://rocketreach.co/..." } ],
      "registry_pages": [ { "host": "zaubacorp.com", "url": "https://www.zaubacorp.com/..." } ],
      "pages_seen": ["https://acme.com/", "https://acme.com/team"],
      "notes": [],
      "status": "done"
    }
  ]
}
```

The CSV is the same data flattened one row per brand, **owner columns first** —
`brand, owner_name, owner_title, owner_phone, owner_email, owner_profile` — then
the rest of the decision makers, the unattributed personal lines, the company
contacts, and the evidence. Multi-value fields are joined with `; `.

### Good to know / limits

- **Cost is roughly `4 Google searches + up to N website pages + 1 registry page`
  per brand**, at the delays you set. Twenty brands at the defaults is about 140
  page loads. Google is the thing that rate-limits, which is why its delay
  defaults to 15s and the website delay to 6s.
- **Nothing here is a paid database.** The six lead databases keep their
  direct-dial numbers behind a login and a bill; this reads their *public* pages
  only, for names and titles. If a brand publishes no contact detail anywhere, the
  row comes back empty and says so — that is the honest answer, not a bug.
- **A generic inbox is the usual result for small brands.** `hello@`, `care@`,
  `info@` are what most sites publish, and those land in `company_contacts`, never
  in `best_contact`. A named owner's personal mobile is genuinely rare on a public
  page; where it exists it is usually a team page, a registry filing, or an SME's
  own footer — and this will not invent one when it is not there.
- **A third-party page never speaks for the brand.** Contacts read off a
  RocketReach, Lusha, LinkedIn or Zauba page are dropped if they belong to *that*
  site's own domain, so `support@rocketreach.co` can never be filed as the brand's
  support address. Only the people they name, and anything inside a person's own
  card, survive from those pages.
- **`no-reply@` addresses are dropped** on purpose, along with build/analytics
  addresses (Sentry, Wix) and `logo@2x.png`-style filenames a regex would
  otherwise read as an address.
- **Check what you send.** Whether you may contact these addresses is a GDPR /
  DPDP / CAN-SPAM question about *your* outreach, not about reading a public page.
  The file gives you the source URL for every claim so a human can verify it
  before anything is sent.

---

## Troubleshooting

**Where to look first.** `chrome://extensions` → the extension's card →
**Service worker** → *Inspect*. That console is where all five background scripts
log. The side panel's own log (last 20 events) is the quicker read for
"what just happened".

| Symptom | What it usually means |
|---|---|
| Mode 2 does nothing, no tab opens | Every line you pasted was rejected. The log says how many were skipped — check for post/reel links. |
| Pauses immediately with `401` | Not logged into instagram.com in this Chrome profile. |
| Pauses on the first page with "API badli" | Instagram changed its endpoints — see below. |
| The page never scrolls | **Expected.** Mode 2 calls Instagram's JSON endpoints directly instead of scrolling. Scrolling only happens in the last-resort DOM fallback. |
| File downloaded but `posts` is short | Check `complete` and `incomplete_reason` in the JSON — it will say `capped`, `private`, or which pause stopped it. |
| Mode 3 is very slow | Expected with details on — one extra request per video. Turn the details checkbox off for a listing-only run, or lower the per-video delay. |
| Mode 3 videos have `null` likes/comments | Either details were off, or that video's `details_error` says why (removed, private, age-gated). |
| Mode 3 pauses with "consent page" | YouTube showed its cookie consent interstitial. Accept it in that tab, then Resume. |
| Mode 3 file has an empty `videos` list | It will say `complete: false` with `no videos found`. Check the side panel log — it names the renderer YouTube actually sent (e.g. `lockupViewModel x30`), which is the one line to add to `VIDEO_KEYS`. |
| Mode 4 stops after a few dozen posts | Usually the `Max posts` limit (default 300) or LinkedIn simply not serving more for that search. Check `posts_collected` vs the limit. |
| Mode 4 posts all end in "…see more" | The see-more buttons did not get clicked — report it; the selector list is `SEE_MORE_SELECTORS` in `content-li-fetch.js`. |
| Mode 4 file has an empty `posts` list | It says `complete: false` with `no posts found`. The log names the selectors that were on the page — that is the one line to fix in `POST_SELECTORS`. |

**If Instagram changes its API.** These endpoints are undocumented and rotate.
When every fallback fails, find the current one yourself:

1. Open a profile in a normal tab with DevTools → **Network** → filter `XHR`.
2. Scroll the post grid. The request that returns the next batch of posts is the
   one to copy — note its path and its request headers.
3. Update the constants at the top of `content-ig-fetch.js`
   (`PROFILE_PATH`, `USER_INFO_PATH`, `TOPSEARCH_PATH`, `FEED_PATH`,
   `GRAPHQL_HASHES`, `FALLBACK_APP_ID`, `LEGACY_APP_ID`) and reload the
   extension.

They are deliberately kept together at the top of that file so this stays a
one-line fix rather than a rewrite.

**If YouTube changes its layout.** Mode 3 looks every field up *by key* rather
than by a fixed path, so a renamed wrapper is survivable and a renamed field
degrades to `null` instead of crashing. When something genuinely breaks:

1. Open a channel's Videos tab with DevTools → **Network** → filter `Fetch/XHR`.
2. Scroll the grid. The `/youtubei/v1/browse` request that returns the next batch
   is the one to compare against — check its `params` (the channel-tab constant)
   and the renderer key the videos arrive under.
3. Update `CHANNEL_TABS` / `VIDEO_KEYS` at the top of `content-yt-fetch.js`, or the
   key names in `extractLikeCount` / `extractCommentCount` / `extractDescription`
   for a details-pass break, and reload the extension.

You usually will not need step 1 and 2: when a tab yields nothing, the log already names
the item renderers that were in the response, and a run that collected nothing is marked
`complete: false` rather than quietly succeeding.

Both of YouTube's current channel layouts are handled — the older `videoRenderer` grid
with a `c4TabbedHeaderRenderer`, and the newer `lockupViewModel` grid with a
`pageHeaderRenderer` whose counts are plain display strings. Channel facts that only the
About panel holds (joined date, country, links) are fetched with a dedicated request when
the channel page does not carry them.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config, permissions, icons |
| `background.js` | Service worker — orchestrates the city × page loop, drives the tab |
| `content-scraper.js` | Injected into the Google results tab — scrapes handles, detects CAPTCHA/block |
| `background-profiles.js` | Service worker — orchestrates the Instagram account queue, persists pages, writes the files |
| `content-ig-fetch.js` | Injected into the Instagram tab — fetches the profile and pages through every post |
| `background-youtube.js` | Service worker — orchestrates the YouTube channel queue, persists pages, writes the files |
| `content-yt-fetch.js` | Injected into the YouTube tab — reads the channel profile and pages through every video |
| `background-linkedin.js` | Service worker — orchestrates the LinkedIn search queue, persists batches, writes the files |
| `content-li-fetch.js` | Injected into the LinkedIn tab — scrolls the search results and reads every post off the page |
| `background-discover.js` | Service worker — owns the discovery frontier (BFS, dedupe, caps) and the creator scorer, writes the file |
| `content-ig-discover.js` | Injected into the Instagram tab — runs a batch of discovery questions and reports candidates |
| `background-brief.js` | Service worker — sequences discovery → selection → export for one brief, writes the plan/shortlist/summary files |
| `background-brands.js` | Service worker — owns the per-brand step queue, the contact merge/dedupe rules and the JSON/CSV output |
| `content-brand-fetch.js` | Injected into whatever page mode 7 is on — reads a Google results page, or mines one web page for emails/phones/socials/people |
| `popup/brief-parse.js` | Pure brief reader (cities, niches, tier, counts → seeds). No DOM, no chrome APIs, testable under Node |
| `offscreen.html` / `offscreen.js` | Turns the collected JSON into a downloadable blob URL (a service worker can't) |
| `popup/` | The side panel UI (HTML/CSS/JS), loaded via `side_panel.default_path` |
| `icons/` | Toolbar/notification icons |
