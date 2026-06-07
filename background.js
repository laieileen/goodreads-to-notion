const SHELF_STATUS_MAP = {
  'read':              'Done',
  'currently-reading': 'Reading',
  'to-read':           'TBR',
  'did-not-finish':    'DNF'
};

const SHELVES = Object.keys(SHELF_STATUS_MAP);

function decodeEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
}

// ── ALARM SETUP ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: 30 });
  console.log('Goodreads→Notion: alarm created');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync') await runSync();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'MANUAL_SYNC') {
    runSync()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_LAST_SYNC') {
    chrome.storage.local.get('lastSync', ({ lastSync }) => {
      sendResponse({ lastSync: lastSync || null });
    });
    return true;
  }
});

// ── MAIN SYNC FUNCTION ───────────────────────────────────────────────────────

async function runSync() {

  const { goodreadsId, notionKey, notionDb, syncedIds = [], installedAt } = await chrome.storage.local.get([
    'goodreadsId', 'notionKey', 'notionDb', 'syncedIds', 'installedAt']);
  // Lock — prevent two syncs running at the same time
  const { syncing } = await chrome.storage.local.get('syncing');
  if (syncing) {
    console.log('Goodreads→Notion: sync already in progress, skipping');
    return;
  }
  await chrome.storage.local.set({ syncing: true });

  try {
    const { goodreadsId, notionKey, notionDb, syncedIds = [] } = await chrome.storage.local.get([
      'goodreadsId', 'notionKey', 'notionDb', 'syncedIds'
    ]);

    if (!goodreadsId || !notionKey || !notionDb) {
      console.log('Goodreads→Notion: not configured, skipping sync');
      return;
    }

    const syncedSet = new Set(syncedIds);
    const newlySynced = [];
    const errors = [];

    for (const shelf of SHELVES) {
      try {
        const books = await fetchShelf(goodreadsId, shelf);

        for (const book of books) {
          const uniqueKey = book.id;
          if (syncedSet.has(uniqueKey)) continue;
        if (installedAt && book.dateAdded) {
          const installedDate = new Date(installedAt).toISOString().split('T')[0];
          const bookDate = new Date(book.dateAdded).toISOString().split('T')[0];
          if (bookDate < installedDate) continue;
        }          
        const status = SHELF_STATUS_MAP[shelf] === 'TBR' && book.isUnreleased
          ? 'Unreleased'
          : SHELF_STATUS_MAP[shelf];

        await addToNotion({ notionKey, notionDb, book, status });

        syncedSet.add(uniqueKey);
        newlySynced.push(book.title);
        }
      } catch (err) {
        console.error(`Error syncing shelf "${shelf}":`, err.message);
        errors.push({ shelf, error: err.message });
      }
    }

    await chrome.storage.local.set({
      syncedIds: [...syncedSet],
      lastSync: new Date().toISOString(),
      lastSyncCount: newlySynced.length,
      lastSyncErrors: errors
    });

    console.log(`Goodreads→Notion: synced ${newlySynced.length} new books`);

  } finally {
    // Always release the lock, even if something errored
    await chrome.storage.local.set({ syncing: false });
  }
}

// ── RSS FETCHING & PARSING ───────────────────────────────────────────────────

async function fetchShelf(goodreadsId, shelf) {
  const url = `https://www.goodreads.com/review/list_rss/${goodreadsId}?shelf=${shelf}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

  const xml = await res.text();
  if (!xml.includes('<item>')) return [];

  const itemBlocks = xml.split('<item>').slice(1);
  return itemBlocks.map(block => {
    const getText = tag => {
      const match = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return (match?.[1] ?? match?.[2] ?? '').trim();
    };
    return parseBookItem(getText);
  });
}

function parseBookItem(getText) {
  const id        = getText('book_id');
  const author    = decodeEntities(getText('author_name')).replace(/\s+/g, ' ').trim();
  const ratingRaw = getText('user_rating');
  const readAt    = getText('user_read_at');
  const bookUrl   = getText('link');
  const rawTitle  = decodeEntities(getText('title'));
  const rawSeries = decodeEntities(getText('book_series'));
  const dateAdded = getText('user_date_added');

  const pubYear  = getText('publication_year');
  const pubMonth = getText('publication_month') || '1';
  const pubDay   = getText('publication_day') || '1';

  let isUnreleased = false;
  if (pubYear) 
  {
    const pubDate = new Date(`${pubYear}-${pubMonth.padStart(2,'0')}-${pubDay.padStart(2,'0')}`);
    isUnreleased = pubDate > new Date();
  }


  // Extract series from title e.g. "Icebreaker (Maple Hills, #1)" → title: "Icebreaker", series: "Maple Hills"
  const titleSeriesMatch = rawTitle.match(/^(.*?)\s*\(([^)]+?)(?:,?\s*#[\d.][\d.-]*)?\)$/);

  const title = titleSeriesMatch ? titleSeriesMatch[1].trim() : rawTitle.trim();
  const seriesFromTitle = titleSeriesMatch ? titleSeriesMatch[2].trim() : '';

  const seriesClean = (seriesFromTitle || rawSeries)
    .replace(/,?\s*#[\d.][\d.-]*/g, '')
    .replace(/^\(|\)$/g, '')
    .trim();

  const ratingNum   = parseInt(ratingRaw, 10);
  const ratingStars = ratingNum > 0 ? '☆'.repeat(ratingNum) : '';

  const finishedDate = readAt
    ? parseGoodreadsDate(readAt)
    : new Date().toISOString().split('T')[0];

  return { id, title, author, series: seriesClean, ratingStars, ratingNum, finishedDate, bookUrl, dateAdded, isUnreleased };
}

function parseGoodreadsDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
    return d.toISOString().split('T')[0];
  } catch (_) {
    return new Date().toISOString().split('T')[0];
  }
}

// ── NOTION API ───────────────────────────────────────────────────────────────

async function addToNotion({ notionKey, notionDb, book, status }) {
  const properties = {
    Title: {
      title: [{ text: { content: book.title || 'Untitled' } }]
    },
    Status: {
      status: { name: status }
    }
  };

  if (book.author) {
    properties['Author'] = { rich_text: [{ text: { content: book.author } }] };
  }
  if (book.series) {
    properties['Series'] = { rich_text: [{ text: { content: book.series } }] };
  }
  if (book.ratingStars) {
    properties['Rating'] = { select: { name: book.ratingStars } };
  }
  if (book.finishedDate && (status === 'Done' || status === 'DNF')) {
    properties['Read'] = { date: { start: book.finishedDate } };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notionKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({ parent: { database_id: notionDb }, properties })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Notion API error ${res.status}`);
  }

  return await res.json();
}
