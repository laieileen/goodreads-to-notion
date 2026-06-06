# Goodreads to Notion

A Chrome extension that automatically syncs your Goodreads shelves to a Notion reading database — no manual logging required.

![Goodreads to Notion popup screenshot](screenshots/popup.png)

## What it does

Whenever you add a book to Goodreads, this extension detects it and creates a new entry in your Notion reading database with the title, author, series, rating, finish date, and reading status automatically filled in. It syncs every 30 minutes in the background, or instantly via the "Sync now" button. Please note that Goodreads takes some time to update its RSS information, so while the extension is instant, Goodreads updating what you've recently added isn't.

---

## Setup

### 1. Notion integration token

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **"New integration"**
3. Give it a name (e.g. "Goodreads") and click **Submit**
4. Copy the **Internal Integration Token** (starts with `ntn_`)

### 2. Connect your database

1. Open your Notion reading database
2. Click **"..."** in the top right → **"Add connections"**
3. Find and select the integration you just created

### 3. Database properties

Your Notion database needs these exact property names and types:

| Property | Type |
|---|---|
| Title | Title (default) |
| Author | Text |
| Series | Text |
| Rating | Select |
| Read | Date |
| Status | Status |

For **Rating**, create select options with star symbols matching however many stars you want to represent (e.g. ☆, ☆☆, ☆☆☆, ☆☆☆☆, ☆☆☆☆☆). If you prefer emojis or a separate categorization, feel free to update the `background.js` file!

### 4. Your Goodreads ID

Found in your Goodreads profile URL:
```
goodreads.com/user/show/YOUR-ID-HERE
```

### 5. Install the extension

1. Download or clone this repo
2. Go to `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder
5. Click the extension icon and complete the setup flow

---

## How it works

Goodreads publishes each user shelf as a public RSS feed:
```
https://www.goodreads.com/review/list_rss/YOUR-ID?shelf=read
```

The extension polls these feeds every 30 minutes using `chrome.alarms`. New books are detected by comparing against a list of already-synced book IDs stored in `chrome.storage.local`. Each new book is added to Notion via the [Notion API](https://developers.notion.com/).

No backend, no server — everything runs locally in the extension.

---

## Limitations

- Goodreads RSS feeds can lag **5–15 minutes** behind real activity
- Only syncs books added **after** the extension is installed (no backfill, if you are interested in a version that updates all previous info, let me know! I actually created that before this, but this suits my personal needs better)
- Goodreads shut down their public API in 2020, so RSS is the only option
- Rating uses whatever select options you've set up in Notion, so make sure they match exactly

---

## Tech stack

- Manifest V3 Chrome Extension
- Vanilla JavaScript
- Notion API (`/v1/pages`, `/v1/search`)
- Goodreads RSS feeds + manual XML parsing (service workers don't support `DOMParser`)
- `chrome.alarms` for background scheduling
- `chrome.storage.local` for persistence

---

## Project structure

```
goodreads-to-notion/
├── manifest.json      # Extension config, permissions
├── background.js      # Service worker: polling, RSS parsing, Notion API
├── popup.html         # Extension UI
├── popup.js           # UI logic, setup flow, manual sync
└── icons/             # Extension icons
```

---

## Contributing

Let me know if you have found a bug or want to add a site-specific scraping improvement!

---

*I built this as a learning project that also just smooths some friction in my daily life! It's a part of a series of Notion productivity extensions that I'm working on.*
