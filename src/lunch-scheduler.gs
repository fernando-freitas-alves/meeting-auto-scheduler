/**
 * Lunch Auto-Scheduler — Google Apps Script
 *
 * Automatically schedules a daily "Lunch" Out-of-Office block on Google
 * Calendar, working around existing meetings.
 *
 * SETUP
 *   1. Go to script.google.com → New project → paste this file
 *   2. Editor → Services (+) → Google Calendar API (v3) → Add
 *   3. Run setupTrigger() once to install the daily trigger
 *   4. Run scheduleLunch() manually first to verify and grant permissions
 *
 * REMOVE
 *   Run removeTrigger(), or Triggers panel → delete manually.
 */

// ── Configuration ─────────────────────────────────────────────────────────────
var CONFIG = {
  CALENDAR_ID: 'primary',
  START_TIMES: ['12:30', '12:15', '12:45', '12:00', '13:00', '13:15', '11:45', '13:30', '11:30'],
  DURATIONS: [60, 45, 30, 15],   // minutes, tried longest-first
  MAX_END: '14:00',
  WINDOW_WEEKS: 2,
  DECLINE_MESSAGE: "Decline because I'm lunching",
  TRIGGER_HOUR: 6,
  DRY_RUN: false
};

// ── Main ──────────────────────────────────────────────────────────────────────

function scheduleLunch() {
  var tz = Session.getScriptTimeZone();

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var offsetToMon = (today.getDay() + 6) % 7; // Mon=0 … Sun=6
  var monday = addDays(today, -offsetToMon);
  var endDate = addDays(monday, 4 + CONFIG.WINDOW_WEEKS * 7);

  log('=== Lunch Scheduler' + (CONFIG.DRY_RUN ? ' [DRY RUN]' : '') + ' ===');
  log('Timezone:  ' + tz);
  log('Calendar:  ' + CONFIG.CALENDAR_ID);
  log('Window:    ' + dateFmt(today) + ' → ' + dateFmt(endDate) + '  (current week + ' + CONFIG.WINDOW_WEEKS + ')');

  var allEvents = fetchAllEvents(
    today.toISOString(),
    addDays(endDate, 1).toISOString(),
    tz
  );
  log('Fetched ' + allEvents.length + ' events');

  var maxEndMins = toMins(CONFIG.MAX_END);
  var minLunchMins = CONFIG.START_TIMES.reduce(function (m, t) { return Math.min(m, toMins(t)); }, toMins(CONFIG.START_TIMES[0]));

  var current = new Date(today);
  while (current <= endDate) {
    if (current.getDay() === 0 || current.getDay() === 6) {
      current = addDays(current, 1);
      continue;
    }

    var dStr = dateFmt(current);
    var dayEvents = getDayEvents(allEvents, dStr, tz);

    // ── Skip PTO / all-day OOO ─────────────────────────────────────────────
    if (isPtoDay(dayEvents, tz)) {
      log('⏭  ' + dStr + '  PTO/all-day OOO — skipping');
      current = addDays(current, 1);
      continue;
    }

    // ── Check existing Lunch OOO ───────────────────────────────────────────
    var lunch = findLunchEvent(dayEvents);
    if (lunch) {
      var lS = eventStartMins(lunch, tz);
      var lE = eventEndMins(lunch, tz);

      if (countConflicts(dayEvents, lS, lE, lunch.id, tz) === 0) {
        log('✓  ' + dStr + '  Lunch ' + fromMins(lS) + '–' + fromMins(lE) + ' — OK, no conflicts');
        current = addDays(current, 1);
        continue;
      }

      log('⚡ ' + dStr + '  Lunch ' + fromMins(lS) + '–' + fromMins(lE) + ' — conflict detected, rescheduling');
      if (!CONFIG.DRY_RUN) {
        try {
          Calendar.Events.remove(CONFIG.CALENDAR_ID, lunch.id);
        } catch (e) {
          log('   ⚠  Could not delete event: ' + e.message);
        }
      }
      allEvents = allEvents.filter(function (e) { return e.id !== lunch.id; });
      dayEvents = dayEvents.filter(function (e) { return e.id !== lunch.id; });
    }

    // ── Find best available slot ───────────────────────────────────────────
    var slot = findBestSlot(dayEvents, maxEndMins, tz);

    if (!slot) {
      var oooInWindow = dayEvents.some(function (e) {
        if (e.eventType !== 'outOfOffice' || (e.summary || '') === 'Lunch' || !e.start.dateTime) return false;
        return eventStartMins(e, tz) < maxEndMins && eventEndMins(e, tz) > minLunchMins;
      });
      log(oooInWindow
        ? '⏭  ' + dStr + '  Already OOO during lunch window — skipping'
        : '❌ ' + dStr + '  No lunch slot available (fully booked until ' + CONFIG.MAX_END + ')'
      );
      current = addDays(current, 1);
      continue;
    }

    // Skip if slot itself is covered by another OOO block
    var oooCovers = dayEvents.some(function (e) {
      if (e.eventType !== 'outOfOffice' || (e.summary || '') === 'Lunch' || !e.start.dateTime) return false;
      return eventStartMins(e, tz) < slot.end && eventEndMins(e, tz) > slot.start;
    });
    if (oooCovers) {
      log('⏭  ' + dStr + '  Already OOO at ' + fromMins(slot.start) + '–' + fromMins(slot.end) + ' — skipping lunch');
      current = addDays(current, 1);
      continue;
    }

    // ── Create OOO event ───────────────────────────────────────────────────
    log('✅ ' + dStr + '  Creating Lunch OOO  ' + fromMins(slot.start) + '–' + fromMins(slot.end) + '  (' + (slot.end - slot.start) + ' min)');

    if (CONFIG.DRY_RUN) {
      log('   [dry-run] skipping Calendar.Events.insert');
    } else {
      try {
        var created = createOooEvent(current, fromMins(slot.start), fromMins(slot.end), tz);
        log('   Created ✓ (' + created.id + ')');
      } catch (e) {
        log('   ⚠  Failed to create event: ' + e.message);
      }
    }

    current = addDays(current, 1);
  }

  log('=== Done ===');
}

// ── Event helpers ─────────────────────────────────────────────────────────────

// The GAS binding accepts eventType but silently drops outOfOfficeProperties.
// Workaround: create the OOO event via the binding, then PATCH outOfOfficeProperties
// via UrlFetchApp to enable auto-decline.
function createOooEvent(date, startHHMM, endHHMM, tz) {
  var created = Calendar.Events.insert({
    summary:   'Lunch',
    start:     { dateTime: floatingDt(date, startHHMM, tz), timeZone: tz },
    end:       { dateTime: floatingDt(date, endHHMM,   tz), timeZone: tz },
    eventType: 'outOfOffice'
  }, CONFIG.CALENDAR_ID);

  // PUT the full event back with autoDeclineMode set — PATCH rejects outOfOfficeProperties
  try {
    var token  = ScriptApp.getOAuthToken();
    var calId  = encodeURIComponent(CONFIG.CALENDAR_ID);
    var url    = 'https://www.googleapis.com/calendar/v3/calendars/' + calId + '/events/' + created.id;
    var getResp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (getResp.getResponseCode() < 400) {
      var full = JSON.parse(getResp.getContentText());
      full.outOfOfficeProperties = {
        autoDeclineMode: 'declineOnlyNewConflictingInvitations',
        declineMessage:  CONFIG.DECLINE_MESSAGE
      };
      var putResp = UrlFetchApp.fetch(url, {
        method:             'put',
        contentType:        'application/json',
        headers:            { Authorization: 'Bearer ' + token },
        payload:            JSON.stringify(full),
        muteHttpExceptions: true
      });
      if (putResp.getResponseCode() >= 400) {
        log('   ⚠  Auto-decline update failed: ' + putResp.getContentText());
      }
    }
  } catch (e) {
    log('   ⚠  Auto-decline update failed: ' + e.message);
  }

  return created;
}

function fetchAllEvents(timeMin, timeMax, tz) {
  var items = [], pageToken;
  do {
    var params = { timeMin: timeMin, timeMax: timeMax, singleEvents: true, maxResults: 250, timeZone: tz };
    if (pageToken) params.pageToken = pageToken;
    var resp = Calendar.Events.list(CONFIG.CALENDAR_ID, params);
    items = items.concat(resp.items || []);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return items;
}

function getDayEvents(allEvents, dStr, tz) {
  return allEvents.filter(function (e) {
    if (e.status === 'cancelled') return false;
    if (e.start.date) {
      return e.start.date <= dStr && e.end.date > dStr;
    }
    if (e.start.dateTime) {
      return Utilities.formatDate(new Date(e.start.dateTime), tz, 'yyyy-MM-dd') === dStr;
    }
    return false;
  });
}

function isPtoDay(dayEvents, tz) {
  return dayEvents.some(function (e) {
    if (e.eventType !== 'outOfOffice') return false;
    if ((e.summary || '') === 'Lunch') return false;
    if (e.start.date) return true;
    if (e.start.dateTime) {
      return Utilities.formatDate(new Date(e.start.dateTime), tz, 'HH:mm') === '00:00';
    }
    return false;
  });
}

function findLunchEvent(dayEvents) {
  for (var i = 0; i < dayEvents.length; i++) {
    if (dayEvents[i].summary === 'Lunch' && dayEvents[i].eventType === 'outOfOffice') return dayEvents[i];
  }
  return null;
}

function isBlocking(event) {
  if (event.status === 'cancelled' || !event.start.dateTime) return false;
  if (event.attendees) {
    for (var i = 0; i < event.attendees.length; i++) {
      if (event.attendees[i].self) {
        var r = event.attendees[i].responseStatus;
        return r !== 'tentative' && r !== 'declined';
      }
    }
  }
  return true; // no attendees = organizer, counts as blocking
}

function eventStartMins(event, tz) {
  return toMins(Utilities.formatDate(new Date(event.start.dateTime), tz, 'HH:mm'));
}

function eventEndMins(event, tz) {
  return toMins(Utilities.formatDate(new Date(event.end.dateTime), tz, 'HH:mm'));
}

function countConflicts(dayEvents, lS, lE, excludeId, tz) {
  return dayEvents.filter(function (e) {
    if (e.id === excludeId || (e.summary || '') === 'Lunch' || !isBlocking(e)) return false;
    return eventStartMins(e, tz) < lE && eventEndMins(e, tz) > lS;
  }).length;
}

function findBestSlot(dayEvents, maxEndMins, tz) {
  var starts = CONFIG.START_TIMES.map(toMins);
  for (var di = 0; di < CONFIG.DURATIONS.length; di++) {
    var dur = CONFIG.DURATIONS[di];
    for (var si = 0; si < starts.length; si++) {
      var s = starts[si], e = s + dur;
      if (e > maxEndMins) continue;
      var busy = dayEvents.some(function (ev) {
        if (!isBlocking(ev)) return false;
        return eventStartMins(ev, tz) < e && eventEndMins(ev, tz) > s;
      });
      if (!busy) return { start: s, end: e };
    }
  }
  return null;
}

// ── Date / time helpers ───────────────────────────────────────────────────────

function toMins(hhmm) {
  var p = hhmm.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

function fromMins(mins) {
  return Utilities.formatString('%02d:%02d', Math.floor(mins / 60), mins % 60);
}

function addDays(date, n) {
  var d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dateFmt(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// Builds a floating dateTime string ("2026-05-27T12:30:00") for use with
// an explicit timeZone field in the Calendar API request.
function floatingDt(date, hhmm, tz) {
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd') + 'T' + hhmm + ':00';
}

function log(msg) {
  Logger.log('[' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss') + '] ' + msg);
}

// ── Trigger management ────────────────────────────────────────────────────────

function setupTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('scheduleLunch')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.TRIGGER_HOUR)
    .create();
  Logger.log('✓ Trigger installed — runs daily at ' + CONFIG.TRIGGER_HOUR + ':00 (weekends skipped in script)');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'scheduleLunch'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('✓ Trigger removed');
}
