/**
 * Focus Time Scheduler — Google Apps Script
 *
 * Fills every free gap of at least MIN_DURATION_MINUTES between your working
 * hours with a Google Calendar "Focus Time" event, working around existing
 * meetings, OOO blocks (including the Lunch Auto-Scheduler's lunch blocks),
 * and all-day PTO/OOO days.
 *
 * All top-level names in this file are prefixed with "FT" so they never
 * collide with identically-purposed helpers in lunch-scheduler.gs or other
 * files in this project (Apps Script merges all .gs files into one global
 * scope).
 *
 * SETUP
 *   1. Google Calendar API (v3) advanced service must be enabled for this
 *      project (Editor -> Services (+) -> Google Calendar API) - already
 *      enabled if lunch-scheduler.gs is installed.
 *   2. Run setupFocusTimeTrigger() once to install the daily trigger.
 *   3. Run scheduleFocusTime() manually first to verify and grant
 *      permissions.
 *
 * RECONCILIATION MODEL (not a daily wipe-and-rebuild)
 *   1. Removes an existing Focus Time block ONLY if it overlaps another,
 *      currently-accepted, busy event (see FT_isAccepted / FT_reconcileDayFocusTime)
 *      - including blocks that already started before 'now', since a
 *      double-booked block isn't valid focus time either way. Non-conflicting
 *      Focus Time blocks are left untouched.
 *   2. Re-fills free space from 'now' forward with fresh Focus Time blocks
 *      (never creates new Focus Time in the past), which naturally rebuilds
 *      around the meeting that caused a conflict.
 *
 * TRIGGER ORDERING
 *   FT_CONFIG.TRIGGER_HOUR defaults to one hour after the Lunch
 *   Auto-Scheduler's TRIGGER_HOUR (6), so lunch blocks are created first and
 *   are already on the calendar (and therefore treated as busy) by the time
 *   this script runs.
 *
 * REMOVE
 *   Run removeFocusTimeTrigger(), or Triggers panel -> delete manually.
 *
 * CALENDAR-CHANGE TRIGGER (ALTERNATIVE)
 *   setupFocusTimeCalendarTrigger() re-runs the scheduler whenever anything on
 *   the calendar changes - guarded against self-triggered loops, see the
 *   "Self-change tracking / loop prevention" section near FT_onCalendarChange().
 */

// -- Configuration -----------------------------------------------------
var FT_CONFIG = {
    CALENDAR_ID: 'primary',
    EVENT_TITLE: 'Focus Time',
    WORK_WINDOWS: {
        // Any weekday not listed here falls back to 'default'. Give a day an
        // empty array to schedule no Focus Time on it at all (e.g. weekends).
        default: [
            { start: '09:00', end: '13:00' },
            { start: '16:00', end: '18:30' }
        ],
        friday: [
            { start: '09:00', end: '18:30' }
        ],
        saturday: [],
        sunday: []
    },
    MIN_DURATION_MINUTES: 15,      // ignore free gaps shorter than this
    WINDOW_WEEKS: 1,               // current Mon-Sun week is week 1; each extra week adds the next full Mon-Sun
    COLOR_ID: '8',                 // Graphite/gray - matches manually created Focus Time events
    IGNORE_FREE_EVENTS: true,      // don't count events marked "Free" as busy
    AUTO_DECLINE_WEEKDAY: 5,       // 0=Sun..6=Sat; Friday=5. Use -1 to disable auto-decline entirely.
    DECLINE_MESSAGE: "Declining - this time is reserved for focus work",
    TRIGGER_HOUR: 7,               // keep after Lunch Auto-Scheduler's TRIGGER_HOUR (6)
    CALENDAR_TRIGGER_COOLDOWN_MINUTES: 5, // safety-net cooldown, see FT_onCalendarChange
    DRY_RUN: false,
    MANAGED_KEY: 'ftManaged',      // extendedProperties.private key tagging events *this script* created
    SELF_REMOVAL_MEMORY_MINUTES: 20 // how long we remember our own deletions for loop detection
};

// -- Work windows (parametrizable per weekday) ---------------------------
// FT_CONFIG.WORK_WINDOWS is a map of weekday name -> array of {start,end}
// "HH:MM" windows for that day. Any weekday not explicitly listed falls
// back to WORK_WINDOWS.default. A day listed with an empty array gets no
// Focus Time scheduled at all that day.
var FT_WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function FT_rawWorkWindowsForDate(date) {
    var name = FT_WEEKDAY_NAMES[date.getDay()];
    var cfg = FT_CONFIG.WORK_WINDOWS || {};
    var raw = cfg.hasOwnProperty(name) ? cfg[name] : (cfg.default || []);
    return raw || [];
}

function FT_workWindowsForDate(date) {
    return FT_rawWorkWindowsForDate(date)
        .map(function (w) { return { start: FT_toMins(w.start), end: FT_toMins(w.end) }; })
        .sort(function (a, b) { return a.start - b.start; });
}

function FT_describeWindows(list) {
    if (!list || !list.length) return '(none)';
    return list.map(function (w) { return w.start + '-' + w.end; }).join(', ');
}


// -- Main ----------------------------------------------------------------
function scheduleFocusTime() {
    var tz = Session.getScriptTimeZone();
    var now = new Date();
    var today = new Date(now);
    today.setHours(0, 0, 0, 0);
    var todayStr = FT_dateFmt(today);
    // WINDOW_WEEKS counts the *current* (possibly partial) week as week 1,
    // the next Mon-Sun week as week 2, and so on - it's a count of calendar
    // weeks, not a flat N*7-day offset from today.
    var daysSinceMonday = (today.getDay() + 6) % 7; // Monday=0 ... Sunday=6
    var currentWeekEnd = FT_addDays(today, 6 - daysSinceMonday); // this week's Sunday
    var endDate = FT_addDays(currentWeekEnd, (FT_CONFIG.WINDOW_WEEKS - 1) * 7);

    FT_log('=== Focus Time Scheduler' + (FT_CONFIG.DRY_RUN ? ' [DRY RUN]' : '') + ' ===');
    FT_log('Timezone: ' + tz);
    FT_log('Calendar: ' + FT_CONFIG.CALENDAR_ID);
    var workWindowOverrideSummary = Object.keys(FT_CONFIG.WORK_WINDOWS)
        .filter(function (k) { return k !== 'default'; })
        .map(function (k) { return k + ': ' + FT_describeWindows(FT_CONFIG.WORK_WINDOWS[k]); })
        .join(', ');
    FT_log('Work windows - default: ' + FT_describeWindows(FT_CONFIG.WORK_WINDOWS.default) +
        (workWindowOverrideSummary ? ' | overrides -> ' + workWindowOverrideSummary : ''));

    FT_log('Window: ' + FT_dateFmt(today) + ' -> ' + FT_dateFmt(endDate) + ' (never touching anything before now: ' + now.toISOString() + ')');

    // Fetch from *now* forward only - we must never look at, let alone modify,
    // anything in the past (Calendar API still returns events that started
    // earlier but end after 'now', so ongoing meetings are still seen).
    var allEvents = FT_fetchAllEvents(now.toISOString(), FT_addDays(endDate, 1).toISOString(), tz);
    FT_log('Fetched ' + allEvents.length + ' events');

    // Tracks what *this run* created/removed, so we can tell the loop-guard
    // which future calendar-change notifications are our own doing.
    var touched = { removed: [] };

    var current = new Date(today);
    while (current <= endDate) {
        var dStr = FT_dateFmt(current);
        var dayWorkWindows = FT_workWindowsForDate(current);
        if (dayWorkWindows.length === 0) {
            FT_log('skip ' + dStr + ' (' + FT_WEEKDAY_NAMES[current.getDay()] + ') - no work window configured');
            current = FT_addDays(current, 1);
            continue;
        }
        var dayMinMins = dayWorkWindows[0].start;
        var dayMaxMins = dayWorkWindows[dayWorkWindows.length - 1].end;

        var dayEvents = FT_getDayEvents(allEvents, dStr, tz);

        // -- Skip PTO / all-day OOO --------------------------------------------
        if (FT_isPtoDay(dayEvents)) {
            FT_log('skip ' + dStr + ' PTO/all-day OOO - skipping');
            current = FT_addDays(current, 1);
            continue;
        }

        // -- Never schedule/consider anything before 'now' for today ----------
        var nowMins = (dStr === todayStr) ? (now.getHours() * 60 + now.getMinutes()) : null;

        // -- Reconcile: remove any existing Focus Time block that overlaps a
        // currently-accepted busy event, regardless of whether it starts before
        // or after 'now' (a double-booked block isn't valid focus time either
        // way). Blocks that don't conflict with anything are left alone.
        var removedCount = FT_reconcileDayFocusTime(dayEvents, dStr, nowMins, touched);

        // -- Busy intervals now include real meetings AND any Focus Time blocks
        //    we kept, so the gap-filler below won't duplicate over them.
        var busy = FT_getBusyIntervals(dayEvents, dayMinMins, dayMaxMins);

        var autoDecline = current.getDay() === FT_CONFIG.AUTO_DECLINE_WEEKDAY;
        var created = 0;

        // -- Walk the gaps within each configured window separately -------------
        dayWorkWindows.forEach(function (win) {
            var winStart = win.start;
            var winEnd = win.end;
            if (nowMins !== null) {
                winStart = Math.max(winStart, nowMins);
            }
            if (winStart >= winEnd) return; // nothing left in this window today

            var winBusy = busy
                .map(function (iv) { return { start: Math.max(iv.start, winStart), end: Math.min(iv.end, winEnd) }; })
                .filter(function (iv) { return iv.end > iv.start; });

            var cursor = winStart;
            for (var i = 0; i <= winBusy.length; i++) {
                var gapEnd = (i < winBusy.length) ? winBusy[i].start : winEnd;
                var gapStart = cursor;

                if (gapEnd - gapStart >= FT_CONFIG.MIN_DURATION_MINUTES) {
                    FT_createFocusTimeEvent(dStr, gapStart, gapEnd, tz, autoDecline);
                    created++;
                }

                if (i < winBusy.length) {
                    cursor = Math.max(cursor, winBusy[i].end);
                }
            }
        });

        FT_log((created > 0 ? 'done ' : 'none ') + dStr + ' - removed ' + removedCount + ', created ' + created +
            ' Focus Time block(s)' + (autoDecline ? ' [auto-decline]' : ''));

        current = FT_addDays(current, 1);
    }

    FT_recordSelfRemovals(touched.removed);
    FT_log('=== Done ===');
}

// -- Event creation --------------------------------------------------------
function FT_createFocusTimeEvent(dStr, startMins, endMins, tz, autoDecline) {
    var startDate = FT_dateAtMins(dStr, startMins);
    var endDate = FT_dateAtMins(dStr, endMins);

    var focusTimeProperties = {
        autoDeclineMode: autoDecline ? 'declineAllConflictingInvitations' : 'declineNone',
        chatStatus: 'available'
    };
    if (autoDecline) {
        focusTimeProperties.declineMessage = FT_CONFIG.DECLINE_MESSAGE;
    }

    var privateProps = {};
    privateProps[FT_CONFIG.MANAGED_KEY] = 'true'; // tag so we can recognize our own writes later

    var event = {
        summary: FT_CONFIG.EVENT_TITLE,
        eventType: 'focusTime',
        colorId: FT_CONFIG.COLOR_ID,
        start: { dateTime: startDate.toISOString(), timeZone: tz },
        end: { dateTime: endDate.toISOString(), timeZone: tz },
        focusTimeProperties: focusTimeProperties,
        extendedProperties: { private: privateProps }
    };

    var label = dStr + ' ' + FT_minsToHHMM(startMins) + '-' + FT_minsToHHMM(endMins);

    if (FT_CONFIG.DRY_RUN) {
        FT_log('  [DRY RUN] would create Focus Time ' + label);
        return null;
    }

    var created = Calendar.Events.insert(event, FT_CONFIG.CALENDAR_ID);
    FT_log('  + Focus Time ' + label);
    return created && created.id;
}

// -- Focus Time bookkeeping ---------------------------------------------
function FT_eventMins(e) {
    var s = new Date(e.start.dateTime);
    var en = new Date(e.end.dateTime);
    return { start: s.getHours() * 60 + s.getMinutes(), end: en.getHours() * 60 + en.getMinutes() };
}

function FT_isFocusTimeEvent(e) {
    if (!e || e.status === 'cancelled') return false;
    return e.eventType === 'focusTime' || e.summary === FT_CONFIG.EVENT_TITLE;
}

// Returns true if we should treat this event as a real commitment that
// Focus Time should never overlap - i.e. it's been *accepted* (or doesn't
// have an RSVP concept at all, like a personal block someone put on their
// own calendar).
function FT_isAccepted(e) {
    if (!e.attendees || !e.attendees.length) return true;
    var self = null;
    for (var i = 0; i < e.attendees.length; i++) {
        if (e.attendees[i].self) { self = e.attendees[i]; break; }
    }
    if (!self) return true; // can't tell who 'we' are in the attendee list - be conservative
    return self.responseStatus === 'accepted';
}

// -- Reconciliation (replaces the old 'clear the whole day, rebuild from
//    scratch' approach) --------------------------------------------------
//
// Removes an existing Focus Time block whenever it overlaps a
// currently-accepted, busy, non-Focus-Time event - regardless of whether
// the block itself starts before 'now'. A block that's double-booked with
// a real meeting isn't valid focus time anyway, so cleaning it up is safe
// at any time, even if the conflict only appeared because the other event
// was just edited/moved. (Creating brand-new Focus Time in the past is
// still never allowed - that stays enforced separately, by the gap-filling
// pass in scheduleFocusTime never considering time before 'now'.)
// Everything that doesn't conflict with anything is left completely alone.
// The caller's normal gap-filling pass then naturally recreates Focus Time
// in whatever free space is left (from now forward), including around the
// meeting that caused the conflict.
function FT_reconcileDayFocusTime(dayEvents, dStr, nowMinsBoundary, touched) {
    var removed = 0;

    // Busy windows contributed by real, accepted, non-Focus-Time events -
    // this is what existing Focus Time blocks get checked against.
    var conflictIntervals = [];
    dayEvents.forEach(function (e) {
        if (e.status === 'cancelled') return;
        if (FT_isFocusTimeEvent(e)) return;
        if (!e.start || !e.start.dateTime || !e.end || !e.end.dateTime) return; // all-day handled by FT_isPtoDay
        if (FT_CONFIG.IGNORE_FREE_EVENTS && e.transparency === 'transparent') return;
        if (!FT_isAccepted(e)) return;
        conflictIntervals.push(FT_eventMins(e));
    });

    for (var i = dayEvents.length - 1; i >= 0; i--) {
        var e = dayEvents[i];
        if (!FT_isFocusTimeEvent(e)) continue;
        if (!e.start || !e.start.dateTime) continue;

        var mins = FT_eventMins(e);

        // No 'started in the past' guard here on purpose - see the function doc
        // comment above. Removing a conflicting block is safe at any time; only
        // *creating new* Focus Time is restricted to now-forward.
        var overlapsAccepted = conflictIntervals.some(function (iv) {
            return mins.start < iv.end && mins.end > iv.start;
        });
        if (!overlapsAccepted) continue;

        var label = dStr + ' ' + FT_minsToHHMM(mins.start) + '-' + FT_minsToHHMM(mins.end);
        if (FT_CONFIG.DRY_RUN) {
            FT_log('  [DRY RUN] would remove conflicting Focus Time ' + label);
        } else {
            Calendar.Events.remove(FT_CONFIG.CALENDAR_ID, e.id);
            touched.removed.push({ id: e.id, ts: Date.now() });
            FT_log('  - removed conflicting Focus Time ' + label);
            removed++;
        }
        dayEvents.splice(i, 1);
    }

    return removed;
}

// -- Busy interval helpers ---------------------------------------------------
function FT_getBusyIntervals(dayEvents, workStartMins, workEndMins) {
    var intervals = [];

    dayEvents.forEach(function (e) {
        if (e.status === 'cancelled') return;
        if (!e.start || !e.start.dateTime || !e.end || !e.end.dateTime) return; // skip all-day events here
        if (FT_CONFIG.IGNORE_FREE_EVENTS && e.transparency === 'transparent') return;

        var s = new Date(e.start.dateTime);
        var en = new Date(e.end.dateTime);
        var startMins = s.getHours() * 60 + s.getMinutes();
        var endMins = en.getHours() * 60 + en.getMinutes();

        startMins = Math.max(startMins, workStartMins);
        endMins = Math.min(endMins, workEndMins);
        if (endMins > startMins) {
            intervals.push({ start: startMins, end: endMins });
        }
    });

    intervals.sort(function (a, b) { return a.start - b.start; });

    var merged = [];
    intervals.forEach(function (iv) {
        var last = merged[merged.length - 1];
        if (last && iv.start <= last.end) {
            last.end = Math.max(last.end, iv.end);
        } else {
            merged.push({ start: iv.start, end: iv.end });
        }
    });

    return merged;
}

// -- Calendar fetch / date helpers -------------------------------------------
// (Self-contained equivalents of the patterns used in lunch-scheduler.gs,
// namespaced with an "FT_" prefix so they can't clash with that file.)

function FT_fetchAllEvents(timeMinIso, timeMaxIso, tz) {
    var events = [];
    var pageToken = null;
    do {
        var resp = Calendar.Events.list(FT_CONFIG.CALENDAR_ID, {
            timeMin: timeMinIso,
            timeMax: timeMaxIso,
            singleEvents: true,
            orderBy: 'startTime',
            timeZone: tz,
            pageToken: pageToken
        });
        events = events.concat(resp.items || []);
        pageToken = resp.nextPageToken;
    } while (pageToken);
    return events;
}

function FT_getDayEvents(allEvents, dStr, tz) {
    return allEvents.filter(function (e) {
        if (!e.start) return false;
        var eventDayStr = e.start.dateTime
            ? Utilities.formatDate(new Date(e.start.dateTime), tz, 'yyyy-MM-dd')
            : e.start.date;
        return eventDayStr === dStr;
    });
}

function FT_isPtoDay(dayEvents) {
    return dayEvents.some(function (e) {
        var isAllDay = e.start && e.start.date && !e.start.dateTime;
        var isOoo = e.eventType === 'outOfOffice';
        return isAllDay && isOoo;
    });
}

function FT_dateFmt(d) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function FT_addDays(d, n) {
    var copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
}

function FT_toMins(hhmm) {
    var parts = hhmm.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function FT_minsToHHMM(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function FT_dateAtMins(dStr, mins) {
    var parts = dStr.split('-');
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    d.setMinutes(mins);
    return d;
}

function FT_log(msg) {
    Logger.log(msg);
}

// -- Trigger management -------------------------------------------------------

function setupFocusTimeTrigger() {
    removeFocusTimeTrigger();
    ScriptApp.newTrigger('scheduleFocusTime')
        .timeBased()
        .everyDays(1)
        .atHour(FT_CONFIG.TRIGGER_HOUR)
        .create();
    FT_log('Installed daily trigger at hour ' + FT_CONFIG.TRIGGER_HOUR);
}

function removeFocusTimeTrigger() {
    ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getHandlerFunction() === 'scheduleFocusTime') {
            ScriptApp.deleteTrigger(t);
        }
    });
}

// -- Calendar-change trigger (alternative to the daily time-based trigger) ---
//
// onEventUpdated() fires on essentially any create/update/delete on the
// calendar, including ones this script just made itself. See the
// 'Self-change tracking / loop prevention' section below FT_onCalendarChange
// for how we avoid re-triggering ourselves in a loop.
//
// Setup:  run setupFocusTimeCalendarTrigger() once.
// Remove: run removeFocusTimeCalendarTrigger(), or delete it from the
//         Triggers panel manually.
// You can run this alongside the daily trigger, or use it instead.

function setupFocusTimeCalendarTrigger() {
    removeFocusTimeCalendarTrigger();
    var calendarId = FT_resolveCalendarId();
    ScriptApp.newTrigger('FT_onCalendarChange')
        .forUserCalendar(calendarId)
        .onEventUpdated()
        .create();
    PropertiesService.getScriptProperties().deleteProperty('FT_SYNC_TOKEN');
    FT_log('Installed calendar-change trigger on ' + calendarId);
}

function removeFocusTimeCalendarTrigger() {
    ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getHandlerFunction() === 'FT_onCalendarChange') {
            ScriptApp.deleteTrigger(t);
        }
    });
}

function FT_resolveCalendarId() {
    return FT_CONFIG.CALENDAR_ID === 'primary'
        ? CalendarApp.getDefaultCalendar().getId()
        : FT_CONFIG.CALENDAR_ID;
}

// -- Self-change tracking / loop prevention ----------------------------------
//
// FT_onCalendarChange fires on ANY calendar change, including the ones this
// script just made (inserting/removing Focus Time). Left unchecked, that's a
// feedback loop: our write triggers the handler, which writes again, which
// triggers the handler again... To break the loop we use the Calendar API's
// incremental sync (syncToken): each firing asks the API exactly which
// events changed since the last time we checked, then ignores any change
// that we can attribute to ourselves:
//   - inserted/updated events carrying our ftManaged extended property
//   - deleted events whose id we logged in FT_RECENT_SELF_REMOVALS
// Only if a genuinely external change remains (someone accepted/declined a
// meeting, moved something, etc.) do we actually re-run the scheduler.

function FT_onCalendarChange(e) {
    var props = PropertiesService.getScriptProperties();

    var externalChange = FT_hasExternalChange(props);
    if (!externalChange) {
        FT_log('Calendar-change trigger fired - no external change detected (self-caused or no-op), skipping');
        return;
    }

    // Lightweight safety-net cooldown in case the sync-token logic ever fails
    // open (e.g. API/quota errors) - keeps worst-case behavior no worse than a
    // plain cooldown would.
    var cooldownMs = (FT_CONFIG.CALENDAR_TRIGGER_COOLDOWN_MINUTES || 5) * 60 * 1000;
    var lastRun = Number(props.getProperty('FT_LAST_CALENDAR_TRIGGER_RUN') || 0);
    var now = Date.now();
    if (now - lastRun < cooldownMs) {
        FT_log('Calendar-change trigger fired with an external change, but skipped (cooldown active, ' +
            Math.round((cooldownMs - (now - lastRun)) / 1000) + 's remaining)');
        return;
    }

    props.setProperty('FT_LAST_CALENDAR_TRIGGER_RUN', String(now));
    FT_log('Calendar-change trigger fired - external change detected, running scheduleFocusTime()');
    scheduleFocusTime();
}

// Returns true if the incremental sync since our last check contains at
// least one change we can't attribute to ourselves.
function FT_hasExternalChange(props) {
    var calendarId = FT_resolveCalendarId();
    var syncToken = props.getProperty('FT_SYNC_TOKEN');
    var recentRemovals = FT_getRecentSelfRemovals(props);
    var external = false;
    var pageToken = null;
    var nextSyncToken = null;

    if (!syncToken) {
        // No baseline yet (first run, or a prior token expired/was reset).
        // Establish one now without treating this call as an external change -
        // otherwise every fresh install would immediately trigger a run. The
        // Calendar API only returns nextSyncToken once every page has been
        // fetched, so we page through fully here instead of capping maxResults.
        // Scoped to [now, now + SEED_HORIZON_DAYS] - matches "never look at the
        // past", and bounds recurring series with no end date (otherwise
        // singleEvents expansion can page near-indefinitely). The scheduler
        // itself never looks further than a couple of weeks ahead, so this
        // horizon comfortably covers anything it cares about.
        try {
            var seedNow = new Date();
            var seedHorizonDays = 60;
            var seedTimeMax = new Date(seedNow.getTime() + seedHorizonDays * 24 * 60 * 60 * 1000);
            var seedPageToken = null;
            var seedToken = null;
            var seedPages = 0;
            do {
                var seed = Calendar.Events.list(calendarId, {
                    singleEvents: true,
                    timeMin: seedNow.toISOString(),
                    timeMax: seedTimeMax.toISOString(),
                    maxResults: 250,
                    pageToken: seedPageToken
                });
                seedPageToken = seed.nextPageToken;
                if (seed.nextSyncToken) seedToken = seed.nextSyncToken;
                seedPages++;
            } while (seedPageToken && seedPages < 20);
            if (seedToken) {
                props.setProperty('FT_SYNC_TOKEN', seedToken);
            } else {
                FT_log('FT_hasExternalChange: seeding did not reach a nextSyncToken after ' + seedPages +
                    ' page(s) within a ' + seedHorizonDays + '-day horizon - will retry establishing baseline on next firing');
            }
        } catch (seedErr) {
            FT_log('FT_hasExternalChange: failed to establish sync token - ' + seedErr);
        }
        return false;
    }

    try {
        do {
            var params = { maxResults: 250, pageToken: pageToken, syncToken: syncToken };
            var resp = Calendar.Events.list(calendarId, params);
            (resp.items || []).forEach(function (item) {
                if (!FT_isSelfCaused(item, recentRemovals)) external = true;
            });
            pageToken = resp.nextPageToken;
            if (resp.nextSyncToken) nextSyncToken = resp.nextSyncToken;
        } while (pageToken);
    } catch (err) {
        var msg = (err && err.message) ? err.message : String(err);
        if (msg.indexOf('410') !== -1 || msg.toLowerCase().indexOf('sync token') !== -1) {
            // Token expired/invalid - reset so we re-baseline next time, and fail
            // open once so we don't silently stop reacting to real changes.
            props.deleteProperty('FT_SYNC_TOKEN');
            FT_log('Sync token expired - resetting (will re-baseline on next call)');
            return true;
        }
        FT_log('FT_hasExternalChange error - failing open: ' + err);
        return true;
    }

    if (nextSyncToken) {
        props.setProperty('FT_SYNC_TOKEN', nextSyncToken);
    }
    return external;
}

function FT_isSelfCaused(item, recentRemovalIds) {
    if (item.status === 'cancelled') {
        return recentRemovalIds.indexOf(item.id) !== -1;
    }
    return !!(item.extendedProperties && item.extendedProperties.private &&
        item.extendedProperties.private[FT_CONFIG.MANAGED_KEY] === 'true');
}

function FT_getRecentSelfRemovals(props) {
    var raw = props.getProperty('FT_RECENT_SELF_REMOVALS');
    if (!raw) return [];
    try {
        var list = JSON.parse(raw);
        var cutoff = Date.now() - FT_CONFIG.SELF_REMOVAL_MEMORY_MINUTES * 60 * 1000;
        return list.filter(function (r) { return r.ts >= cutoff; }).map(function (r) { return r.id; });
    } catch (e) {
        return [];
    }
}

function FT_recordSelfRemovals(removed) {
    if (!removed || !removed.length) return;
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('FT_RECENT_SELF_REMOVALS');
    var list = [];
    if (raw) {
        try { list = JSON.parse(raw); } catch (e) { list = []; }
    }
    var cutoff = Date.now() - FT_CONFIG.SELF_REMOVAL_MEMORY_MINUTES * 60 * 1000;
    list = list.filter(function (r) { return r.ts >= cutoff; }).concat(removed);
    props.setProperty('FT_RECENT_SELF_REMOVALS', JSON.stringify(list));
}


