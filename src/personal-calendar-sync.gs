/**
 * Personal Calendar Sync — Google Apps Script
 *
 * Mirrors busy events from a personal Google Calendar into your work calendar
 * as OOO blocks, so personal appointments block your work slots without
 * exposing their details.
 *
 * SETUP
 *   1. Deploy via clasp or paste into script.google.com alongside lunch-scheduler.gs
 *   2. Services (+) → Google Calendar API (v3) → Add  (skip if already added)
 *   3. Set PERSONAL_CALENDAR_ID in CONFIG below
 *   4. Run syncPersonalCalendar() once to grant permissions and verify
 *   5. Run setupSyncTrigger() to install the hourly trigger
 *
 * REMOVE
 *   Run removeSyncTrigger(), then removeMirroredEvents() to clean up work calendar.
 */

// ── Configuration ─────────────────────────────────────────────────────────────
var SYNC_CONFIG = {
  PERSONAL_CALENDAR_ID: 'your.personal@gmail.com', // REQUIRED — set your personal calendar ID
  WORK_CALENDAR_ID: 'primary',
  WINDOW_WEEKS: 4,          // weeks ahead to sync
  MIRROR_SUMMARY: 'Busy', // title shown on work calendar
  DECLINE_MESSAGE: "I have a personal commitment",
  TRIGGER_HOUR: 6,          // hour for the daily catch-all trigger
  DRY_RUN: false
};

// Tag used to identify events created by this script
var MIRROR_TAG = 'personal-calendar-sync';

// ── Main ──────────────────────────────────────────────────────────────────────

function syncPersonalCalendar() {
  var tz = Session.getScriptTimeZone();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var endDate = addDaysSc(today, SYNC_CONFIG.WINDOW_WEEKS * 7);

  syncLog('=== Personal Calendar Sync' + (SYNC_CONFIG.DRY_RUN ? ' [DRY RUN]' : '') + ' ===');
  syncLog('Personal: ' + SYNC_CONFIG.PERSONAL_CALENDAR_ID);
  syncLog('Work:     ' + SYNC_CONFIG.WORK_CALENDAR_ID);
  syncLog('Window:   ' + dateFmtSc(today) + ' → ' + dateFmtSc(endDate));

  var timeMin = today.toISOString();
  var timeMax = addDaysSc(endDate, 1).toISOString();

  // Fetch personal events and existing mirrors in parallel
  var personalEvents = fetchAllEventsSc(SYNC_CONFIG.PERSONAL_CALENDAR_ID, timeMin, timeMax, tz);
  var mirrors = fetchMirrors(SYNC_CONFIG.WORK_CALENDAR_ID, timeMin, timeMax);

  syncLog('Personal events: ' + personalEvents.length + '  |  Existing mirrors: ' + mirrors.length);

  // Index mirrors by source ID for O(1) lookup
  var mirrorBySourceId = {};
  mirrors.forEach(function (m) {
    var srcId = m.extendedProperties && m.extendedProperties.private
      ? m.extendedProperties.private.mirrorSourceId
      : null;
    if (srcId) mirrorBySourceId[srcId] = m;
  });

  // Index personal events by ID to detect deletions
  var personalById = {};
  personalEvents.forEach(function (e) { personalById[e.id] = e; });

  var created = 0, updated = 0, deleted = 0, skipped = 0;

  // ── Create / update mirrors for personal events ────────────────────────────
  personalEvents.forEach(function (e) {
    var skipReason = shouldSkip(e);
    if (skipReason) {
      syncLog('⏭  ' + eventDateRangeSc(e, tz) + '  skipped (' + skipReason + ')  [' + (e.summary || '(no title)') + ']');
      skipped++;
      return;
    }

    var existing = mirrorBySourceId[e.id];

    if (!existing) {
      syncLog('➕ ' + eventDateRangeSc(e, tz) + '  ' + SYNC_CONFIG.MIRROR_SUMMARY);
      if (!SYNC_CONFIG.DRY_RUN) createMirror(e, tz);
      created++;
    } else if (mirrorNeedsUpdate(existing, e, tz)) {
      syncLog('✏️  ' + eventDateRangeSc(e, tz) + '  updating mirror');
      if (!SYNC_CONFIG.DRY_RUN) updateMirror(existing, e, tz);
      updated++;
      delete mirrorBySourceId[e.id]; // mark as handled
    } else {
      syncLog('✓  ' + eventDateRangeSc(e, tz) + '  mirror up to date');
      delete mirrorBySourceId[e.id];
    }
  });

  // ── Delete mirrors whose source event no longer exists ─────────────────────
  Object.keys(mirrorBySourceId).forEach(function (srcId) {
    var stale = mirrorBySourceId[srcId];
    syncLog('🗑  Removing stale mirror: ' + (stale.start.dateTime || stale.start.date));
    if (!SYNC_CONFIG.DRY_RUN) {
      try {
        Calendar.Events.remove(SYNC_CONFIG.WORK_CALENDAR_ID, stale.id);
      } catch (e) {
        syncLog('   ⚠  Could not delete: ' + e.message);
      }
    }
    deleted++;
  });

  syncLog('Done — created: ' + created + '  updated: ' + updated + '  deleted: ' + deleted + '  skipped: ' + skipped);
}

// ── Mirror logic ──────────────────────────────────────────────────────────────

// Returns a skip reason string, or null if the event should be mirrored.
function shouldSkip(event) {
  if (event.status === 'cancelled') return 'cancelled';
  // Skip free/transparent events
  if (event.transparency === 'transparent') return 'free';
  // Skip declined invitations
  if (event.attendees) {
    for (var i = 0; i < event.attendees.length; i++) {
      if (event.attendees[i].self && event.attendees[i].responseStatus === 'declined') return 'declined';
    }
  }
  // All-day events: only mirror if explicitly marked as OOO (otherwise likely a reminder)
  if (event.start.date && event.eventType !== 'outOfOffice') {
    return 'all-day non-OOO (eventType=' + (event.eventType || 'default') + ')';
  }
  // Timed events: always mirror (block the slot regardless of eventType)
  return null;
}

function mirrorNeedsUpdate(mirror, source, tz) {
  // Compare using the timed representation so all-day sources compare correctly
  var src = timedStartEnd(source, tz);
  var mStart = mirror.start.dateTime;
  var mEnd = mirror.end.dateTime;
  return mStart !== src.start || mEnd !== src.end;
}

function createMirror(sourceEvent, tz) {
  var token = ScriptApp.getOAuthToken();
  var calId = encodeURIComponent(SYNC_CONFIG.WORK_CALENDAR_ID);
  var url = 'https://www.googleapis.com/calendar/v3/calendars/' + calId + '/events';

  var body = buildMirrorBody(sourceEvent);

  var created = apiRequest('post', url, body, token);
  if (!created || !created.id) return;

  // Set auto-decline via PUT (PATCH rejects outOfOfficeProperties)
  setAutoDecline(created.id, created, token);
}

function updateMirror(mirror, sourceEvent, tz) {
  var token = ScriptApp.getOAuthToken();
  var calId = encodeURIComponent(SYNC_CONFIG.WORK_CALENDAR_ID);
  var url = 'https://www.googleapis.com/calendar/v3/calendars/' + calId + '/events/' + mirror.id;

  var body = buildMirrorBody(sourceEvent);
  body.id = mirror.id;

  var updated = apiRequest('put', url, body, token);
  if (!updated || !updated.id) return;

  setAutoDecline(updated.id, updated, token);
}

function buildMirrorBody(sourceEvent) {
  var tz = Session.getScriptTimeZone();
  var span = timedStartEnd(sourceEvent, tz);
  return {
    summary: SYNC_CONFIG.MIRROR_SUMMARY,
    start: { dateTime: span.start, timeZone: tz },
    end: { dateTime: span.end, timeZone: tz },
    eventType: 'outOfOffice',
    extendedProperties: {
      private: {
        mirrorSource: MIRROR_TAG,
        mirrorSourceId: sourceEvent.id
      }
    }
  };
}

// Returns { start, end } as floating dateTime strings in tz.
// All-day events (start.date) are expanded to 00:00–00:00 of the next day
// because the Calendar API rejects all-day OOO events.
function timedStartEnd(event, tz) {
  if (event.start.dateTime) {
    return { start: event.start.dateTime, end: event.end.dateTime };
  }
  // All-day: start.date = "YYYY-MM-DD", end.date = exclusive next day
  return {
    start: event.start.date + 'T00:00:00',
    end: event.end.date + 'T00:00:00'
  };
}

function setAutoDecline(eventId, fullEvent, token) {
  var calId = encodeURIComponent(SYNC_CONFIG.WORK_CALENDAR_ID);
  var url = 'https://www.googleapis.com/calendar/v3/calendars/' + calId + '/events/' + eventId;
  var body = JSON.parse(JSON.stringify(fullEvent)); // deep copy
  body.outOfOfficeProperties = {
    autoDeclineMode: 'declineOnlyNewConflictingInvitations',
    declineMessage: SYNC_CONFIG.DECLINE_MESSAGE
  };
  apiRequest('put', url, body, token);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function fetchAllEventsSc(calendarId, timeMin, timeMax, tz) {
  var items = [], pageToken;
  do {
    var params = { timeMin: timeMin, timeMax: timeMax, singleEvents: true, maxResults: 250, timeZone: tz };
    if (pageToken) params.pageToken = pageToken;
    var resp = Calendar.Events.list(calendarId, params);
    items = items.concat(resp.items || []);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return items;
}

function fetchMirrors(calendarId, timeMin, timeMax) {
  var items = [], pageToken;
  do {
    var params = {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      maxResults: 250,
      privateExtendedProperty: 'mirrorSource=' + MIRROR_TAG
    };
    if (pageToken) params.pageToken = pageToken;
    var resp = Calendar.Events.list(calendarId, params);
    items = items.concat(resp.items || []);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return items;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

// Run once to delete all mirrored events from the work calendar.
function removeMirroredEvents() {
  var today = new Date();
  var endDate = addDaysSc(today, 365);
  var mirrors = fetchMirrors(SYNC_CONFIG.WORK_CALENDAR_ID, today.toISOString(), endDate.toISOString());
  syncLog('Removing ' + mirrors.length + ' mirrored events…');
  mirrors.forEach(function (m) {
    try {
      if (!SYNC_CONFIG.DRY_RUN) Calendar.Events.remove(SYNC_CONFIG.WORK_CALENDAR_ID, m.id);
      syncLog('  🗑  ' + (m.start.dateTime || m.start.date));
    } catch (e) {
      syncLog('  ⚠  ' + e.message);
    }
  });
  syncLog('Done.');
}

// ── API helper ────────────────────────────────────────────────────────────────

function apiRequest(method, url, body, token) {
  var resp = UrlFetchApp.fetch(url, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    syncLog('   ⚠  API ' + method.toUpperCase() + ' failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
    return null;
  }
  return JSON.parse(resp.getContentText());
}

// ── Date / time helpers ───────────────────────────────────────────────────────

function addDaysSc(date, n) {
  var d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dateFmtSc(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function eventDateRangeSc(event, tz) {
  var start = event.start.dateTime
    ? Utilities.formatDate(new Date(event.start.dateTime), tz, 'yyyy-MM-dd HH:mm')
    : event.start.date;
  var end = event.end.dateTime
    ? Utilities.formatDate(new Date(event.end.dateTime), tz, 'HH:mm')
    : event.end.date;
  return start + '–' + end;
}

function syncLog(msg) {
  Logger.log('[' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss') + '] ' + msg);
}

// ── Trigger management ────────────────────────────────────────────────────────

function setupSyncTrigger() {
  removeSyncTrigger();
  // Hourly trigger catches same-day personal calendar changes quickly
  ScriptApp.newTrigger('syncPersonalCalendar')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('✓ Sync trigger installed — runs every hour');
}

function removeSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'syncPersonalCalendar'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('✓ Sync trigger removed');
}
