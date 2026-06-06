// popup.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles the popup UI — setup flow, connection check, and sync status display.
// Communicates with background.js via chrome.runtime.sendMessage for syncing.
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ── INIT ─────────────────────────────────────────────────────────────────────
// Runs every time the popup opens. Checks if already configured → routes to
// the right screen.

async function init() {
  const { goodreadsId, notionKey, notionDb } = await chrome.storage.local.get([
    'goodreadsId', 'notionKey', 'notionDb'
  ]);

  if (goodreadsId && notionKey && notionDb) {
    showScreen('main');
    await loadMainScreen(notionKey, notionDb);
  } else {
    showScreen('setup');
    // If we have a key but no DB (e.g. closed popup mid-setup), pre-fill
    if (notionKey) {
      $('apiKey').value = notionKey;
      $('connectBtn').disabled = false;
      $('apiKeyHint').textContent = 'Key saved — click Connect to pick a database';
    }
    if (goodreadsId) {
      $('goodreadsId').value = goodreadsId;
    }
  }
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(name).classList.add('active');
}


// ── SETUP — GOODREADS ID VALIDATION ──────────────────────────────────────────
// Fires on every keystroke. Goodreads usernames can be letters, numbers,
// hyphens. We just check it's not empty and not obviously wrong.

$('goodreadsId').addEventListener('input', () => {
  const val = $('goodreadsId').value.trim();
  const hint = $('goodreadsHint');

  if (!val) {
    hint.className = 'field-hint';
    hint.innerHTML = 'Found in your profile URL: goodreads.com/user/show/<strong>your-name</strong>';
    return;
  }

  if (val.includes('goodreads.com')) {
    // They pasted the full URL — extract the ID/username for them
    const match = val.match(/goodreads\.com\/user\/show\/([^?/]+)/);
    if (match) {
      $('goodreadsId').value = match[1];
      hint.className = 'field-hint ok';
      hint.textContent = 'Extracted from URL ✓';
    } else {
      hint.className = 'field-hint err';
      hint.textContent = 'Could not extract ID from URL — try just the username';
    }
    return;
  }

  hint.className = 'field-hint ok';
  hint.textContent = `Will sync: goodreads.com/user/show/${val}`;
  maybeEnableConnect();
});


// ── SETUP — API KEY VALIDATION ────────────────────────────────────────────────

$('apiKey').addEventListener('input', () => {
  const val = $('apiKey').value.trim();
  const hint = $('apiKeyHint');

  if (!val) {
    $('apiKey').className = '';
    hint.className = 'field-hint';
    hint.innerHTML = 'Get yours at <a href="https://www.notion.so/my-integrations" target="_blank">notion.so/my-integrations</a>';
    $('connectBtn').disabled = true;
    return;
  }

  if (!val.startsWith('ntn_') && !val.startsWith('secret_')) {
    $('apiKey').className = 'invalid';
    hint.className = 'field-hint err';
    hint.textContent = 'Token must start with "ntn_" or "secret_"';
    $('connectBtn').disabled = true;
    return;
  }

  if (val.length < 20) {
    $('apiKey').className = '';
    hint.className = 'field-hint';
    hint.textContent = 'Keep typing…';
    $('connectBtn').disabled = true;
    return;
  }

  $('apiKey').className = 'valid';
  hint.className = 'field-hint ok';
  hint.textContent = 'Looks good — click Connect to verify';
  maybeEnableConnect();
});

// Only enable Connect when BOTH fields look valid
function maybeEnableConnect() {
  const keyVal = $('apiKey').value.trim();
  const idVal  = $('goodreadsId').value.trim();
  const keyOk  = (keyVal.startsWith('ntn_') || keyVal.startsWith('secret_')) && keyVal.length >= 20;
  const idOk   = idVal.length > 0;
  $('connectBtn').disabled = !(keyOk && idOk);
}


// ── CONNECT BUTTON ────────────────────────────────────────────────────────────
// Verifies the Notion token by fetching databases.
// Also verifies the Goodreads feed is reachable.

$('connectBtn').addEventListener('click', async () => {
  const apiKey     = $('apiKey').value.trim();
  const goodreadsId = $('goodreadsId').value.trim();

  $('connectingState').classList.add('show');
  $('connectBtn').disabled = true;
  $('apiKeyHint').className = 'field-hint';
  $('apiKeyHint').textContent = '';

  try {
    // Verify Goodreads feed first
    await verifyGoodreadsFeed(goodreadsId);

    // Then verify Notion token + fetch databases
    const databases = await fetchDatabases(apiKey);

    $('connectingState').classList.remove('show');

    if (databases.length === 0) {
      $('apiKeyHint').className = 'field-hint err';
      $('apiKeyHint').textContent = 'No databases found — make sure your integration has access to at least one.';
      $('connectBtn').disabled = false;
      return;
    }

    // Save both credentials now
    await chrome.storage.local.set({ notionKey: apiKey, goodreadsId });

    // Show the DB picker
    populateDbDropdown('dbSelect', databases);
    $('dbSection').style.display = 'block';
    $('apiKeyHint').className = 'field-hint ok';
    $('apiKeyHint').textContent = `Connected! Found ${databases.length} database(s).`;

  } catch (err) {
    $('connectingState').classList.remove('show');
    $('connectBtn').disabled = false;

    if (err.type === 'goodreads') {
      $('goodreadsHint').className = 'field-hint err';
      $('goodreadsHint').textContent = `Could not reach Goodreads feed — check your username/ID`;
    } else {
      $('apiKeyHint').className = 'field-hint err';
      $('apiKeyHint').textContent = err.status === 401
        ? 'Invalid Notion token — double-check in your integrations.'
        : `Connection failed: ${err.message}`;
    }
  }
});

// Checks that the Goodreads RSS feed returns something valid
async function verifyGoodreadsFeed(goodreadsId) {
  try {
    const url = `https://www.goodreads.com/review/list_rss/${goodreadsId}?shelf=read`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`Goodreads returned ${res.status}`);
      err.type = 'goodreads';
      throw err;
    }
    const text = await res.text();
    if (!text.includes('<rss') && !text.includes('<feed')) {
      const err = new Error('Not a valid RSS feed');
      err.type = 'goodreads';
      throw err;
    }
  } catch (e) {
    if (e.type === 'goodreads') throw e;
    const err = new Error(e.message);
    err.type = 'goodreads';
    throw err;
  }
}


// ── NOTION DATABASE HELPERS ───────────────────────────────────────────────────

async function fetchDatabases(apiKey) {
  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      filter: { property: 'object', value: 'database' },
      page_size: 50
    })
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const err = new Error(e.message || 'Unknown error');
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return data.results.map(db => ({
    id: db.id,
    name: db.title?.map(t => t.plain_text).join('') || 'Untitled'
  }));
}

function populateDbDropdown(selectId, databases) {
  const sel = $(selectId);
  sel.innerHTML = '';
  databases.forEach(db => {
    const opt = document.createElement('option');
    opt.value = db.id;
    opt.textContent = '📖 ' + db.name;
    sel.appendChild(opt);
  });
}


// ── SAVE SETTINGS ─────────────────────────────────────────────────────────────

$('saveSettings').addEventListener('click', async () => {
  const dbId   = $('dbSelect').value;
  const apiKey = $('apiKey').value.trim();
  const goodreadsId = $('goodreadsId').value.trim();

  if (!dbId) return;

  // Save everything together atomically
  await chrome.storage.local.set({
    notionKey: apiKey,
    notionDb: dbId,
    goodreadsId,
    // Record install time — we only sync books added AFTER this moment
    // by storing the current timestamp as our baseline
    installedAt: new Date().toISOString()
  });

  showScreen('main');
  await loadMainScreen(apiKey, dbId);

  // Trigger an immediate first sync
  chrome.runtime.sendMessage({ type: 'MANUAL_SYNC' });
  setStatus('First sync started…', '');
});


// ── MAIN SCREEN ───────────────────────────────────────────────────────────────

async function loadMainScreen(apiKey, currentDbId) {
  // Load last sync info from storage
  const { lastSync, lastSyncCount, goodreadsId } = await chrome.storage.local.get([
    'lastSync', 'lastSyncCount', 'goodreadsId'
  ]);

  // Update last sync text
  if (lastSync) {
    const d = new Date(lastSync);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const countStr = lastSyncCount > 0 ? ` · ${lastSyncCount} added` : ' · nothing new';
    $('lastSyncText').textContent = `Last sync ${dateStr} at ${timeStr}${countStr}`;
  } else {
    $('lastSyncText').textContent = 'No sync yet — click Sync now';
    $('syncDot').classList.add('inactive');
  }

  // Populate DB dropdown
  try {
    const databases = await fetchDatabases(apiKey);
    populateDbDropdown('mainDbSelect', databases);
    $('mainDbSelect').value = currentDbId;

    // Show DB name in header
    const selectedName = $('mainDbSelect').options[$('mainDbSelect').selectedIndex]?.textContent || '';
    $('mainDbName').textContent = selectedName.replace('📖 ', '');

    // When DB changes, persist it
    $('mainDbSelect').onchange = async () => {
      const newId   = $('mainDbSelect').value;
      const newName = $('mainDbSelect').options[$('mainDbSelect').selectedIndex]?.textContent || '';
      await chrome.storage.local.set({ notionDb: newId });
      $('mainDbName').textContent = newName.replace('📖 ', '');
    };
  } catch (_) {
    $('mainDbSelect').innerHTML = '<option>Could not load databases</option>';
  }
}

// Settings button → back to setup, pre-filled
$('openSettings').addEventListener('click', async () => {
  showScreen('setup');
  $('backToMain').style.display = 'block';
  const { notionKey, goodreadsId } = await chrome.storage.local.get(['notionKey', 'goodreadsId']);
  if (notionKey) {
    $('apiKey').value = notionKey;
    $('apiKey').className = 'valid';
    $('apiKeyHint').className = 'field-hint ok';
    $('apiKeyHint').textContent = 'Key saved — click Connect to re-verify';
    maybeEnableConnect();
  }
  if (goodreadsId) {
    $('goodreadsId').value = goodreadsId;
    $('goodreadsHint').className = 'field-hint ok';
    $('goodreadsHint').textContent = `Syncing: goodreads.com/user/show/${goodreadsId}`;
  }
  maybeEnableConnect();
});

$('backToMain').addEventListener('click', () => {
  $('backToMain').style.display = 'none';
  showScreen('main');
});


// ── SYNC NOW BUTTON ───────────────────────────────────────────────────────────

$('syncNowBtn').addEventListener('click', async () => {
  $('syncNowBtn').disabled = true;
  $('syncNowBtn').textContent = 'Syncing…';
  setStatus('Syncing with Goodreads…', '');

  chrome.runtime.sendMessage({ type: 'MANUAL_SYNC' }, async response => {
    $('syncNowBtn').disabled = false;
    $('syncNowBtn').textContent = 'Sync now';

    if (response?.success) {
      // Reload the last sync info from storage
      const { lastSync, lastSyncCount } = await chrome.storage.local.get(['lastSync', 'lastSyncCount']);
      const countStr = lastSyncCount > 0
        ? `${lastSyncCount} new book${lastSyncCount > 1 ? 's' : ''} added!`
        : 'All up to date';
      setStatus(countStr, lastSyncCount > 0 ? 'success' : '');

      if (lastSync) {
        const d = new Date(lastSync);
        $('lastSyncText').textContent = `Last sync just now · ${lastSyncCount > 0 ? lastSyncCount + ' added' : 'nothing new'}`;
        $('syncDot').classList.remove('inactive');
      }
    } else {
      setStatus(`Sync failed: ${response?.error || 'unknown error'}`, 'error');
    }
  });
});


// ── HELPERS ───────────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
}


init();
