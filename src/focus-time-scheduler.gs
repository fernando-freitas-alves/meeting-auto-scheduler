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
 * TRIGGER ORDERING
 *   FT_CONFIG.TRIGGER_HOUR defaults to one hour after the Lunch
 *   Auto-Scheduler's TRIGGER_HOUR (6), so lunch blocks are created first and
 *   are already on the calendar (and therefore treated as busy) by the time
 *   this script runs. Apps Script daily triggers fire at an arbitrary minute
 *   within the chosen hour, so keep at least a 1-hour buffer between the two
 *   TRIGGER_HOUR values - or, for a guaranteed order, call
 *   scheduleFocusTime() directly at the end of scheduleLunch() instead of
 *   using a separate trigger.
 *
 * REMOVE
 *   Run removeFocusTimeTrigger(), or Triggers panel -> delete manually.
 *
 * CALENDAR-CHANGE TRIGGER (ALTERNATIVE)
 *   Instead of (or in addition to) the daily trigger, run
 *   setupFocusTimeCalendarTrigger() once to re-run the scheduler whenever
 *   anything on the calendar changes. See notes near FT_onCalendarChange().
 */

// -- Configuration -----------------------------------------------------
var FT_CONFIG = {
    CALENDAR_ID: 'primary',
    EVENT_TITLE: 'Focus Time',
    WORK_WINDOWS: [
        { start: '09:00', end: '13:00' },
        { start: '16:00', end: '18:00' }
    ],                             // list of {start,end} windows ("HH:MM") to fill with Focus Time each day
    MIN_DURATION_MINUTES: 15,      // ignore free gaps shorter than this
    WINDOW_WEEKS: 1,               // how far ahead to schedule
    COLOR_ID: '8',                 // Graphite/gray - matches manually created Focus Time events
    IGNORE_FREE_EVENTS: true,      // don't count events marked "Free" as busy
    AUTO_DECLINE_WEEKDAY: 5,       // 0=Sun..6=Sat; Friday=5. Use -1 to disable auto-decline entirely.
    DECLINE_MESSAGE: "Declining - this time is reserved for focus work",
    TRIGGER_HOUR: 7,               // keep after Lunch Auto-Scheduler's TRIGGER_HOUR (6)
    CALENDAR_TRIGGER_COOLDOWN_MINUTES: 5,  // min minutes between runs triggered by calendar-change events
    DRY_RUN: false
};

// -- Main ----------------------------------------------------------------

function scheduleFocusTime() {
    var tz = Session.getScriptTimeZone();

    var now = new Date();
    var today = new Date(now);
    today.setHours(0, 0, 0, 0);
    var todayStr = FT_dateFmt(today);

    var endDate = FT_addDays(today, FT_CONFIG.WINDOW_WEEKS * 7);

    FT_log('=== Focus Time Scheduler' + (FT_CONFIG.DRY_RUN ? ' [DRY RUN]' : '') + ' ===');
    FT_log('Timezone: ' + tz);
    FT_log('Calendar: ' + FT_CONFIG.CALENDAR_ID);
    FT_log('Working hours: ' + FT_CONFIG.WORK_WINDOWS.map(function (w) { return w.start + '-' + w.end; }).join(', '));
    FT_log('Window: ' + FT_dateFmt(today) + ' -> ' + FT_dateFmt(endDate));

    var allEvents = FT_fetchAllEvents(
        today.toISOString(),
        FT_addDays(endDate, 1).toISOString(),
        tz
    );
    FT_log('Fetched ' + allEvents.length + ' events');

    var workWindows = FT_CONFIG.WORK_WINDOWS
        .map(function (w) { return { start: FT_toMins(w.start), end: FT_toMins(w.end) }; })
        .sort(function (a, b) { return a.start - b.start; });

    var dayMinMins = workWindows[0].start;
    var dayMaxMins = workWindows[workWindows.length - 1].end;

    var current = new Date(today);
    while (current <= endDate) {
        if (current.getDay() === 0 || current.getDay() === 6) {
            current = FT_addDays(current, 1);
            continue;
        }

        var dStr = FT_dateFmt(current);
        var dayEvents = FT_getDayEvents(allEvents, dStr, tz);

        // -- Skip PTO / all-day OOO --------------------------------------------
        if (FT_isPtoDay(dayEvents)) {
            FT_log('skip ' + dStr + ' PTO/all-day OOO - skipping');
            current = FT_addDays(current, 1);
            continue;
        }

        // -- Never schedule in the past for today -------------------------------
        var nowMins = (dStr === todayStr) ? (now.getHours() * 60 + now.getMinutes()) : null;

        // -- Build merged busy intervals across the full day envelope -----------
        var busy = FT_getBusyIntervals(dayEvents, dayMinMins, dayMaxMins);

        var autoDecline = current.getDay() === FT_CONFIG.AUTO_DECLINE_WEEKDAY;
        var created = 0;

        // -- Walk the gaps within each configured window separately -------------
        workWindows.forEach(function (win) {
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
                    var mergedRange = FT_mergeAdjacentFocusTime(dayEvents, dStr, gapStart, gapEnd);
                    FT_createFocusTimeEvent(dStr, mergedRange.start, mergedRange.end, tz, autoDecline);
                    created++;
                }

                if (i < winBusy.length) {
                    cursor = Math.max(cursor, winBusy[i].end);
                }
            }
        });

        FT_log((created > 0 ? 'done ' : 'none ') + dStr + ' - ' + created + ' Focus Time block(s)' +
            (autoDecline ? ' [auto-decline]' : ''));

        current = FT_addDays(current, 1);
    }

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

    var event = {
        summary: FT_CONFIG.EVENT_TITLE,
        eventType: 'focusTime',
        colorId: FT_CONFIG.COLOR_ID,
        start: { dateTime: startDate.toISOString(), timeZone: tz },
        end: { dateTime: endDate.toISOString(), timeZone: tz },
        focusTimeProperties: focusTimeProperties
    };

    var label = dStr + ' ' + FT_minsToHHMM(startMins) + '-' + FT_minsToHHMM(endMins);

    if (FT_CONFIG.DRY_RUN) {
        FT_log('  [DRY RUN] would create Focus Time ' + label);
        return;
    }

    Calendar.Events.insert(event, FT_CONFIG.CALENDAR_ID);
    FT_log('  + Focus Time ' + label);
}

// -- Adjacent Focus Time merging ---------------------------------------------
//
// If a new Focus Time block would sit flush against an existing Focus Time
// event (created by an earlier run, or manually) - e.g. because a meeting
// that used to separate them was moved/deleted - merge them into a single
// continuous block instead of leaving several back-to-back events.

function FT_mergeAdjacentFocusTime(dayEvents, dStr, gapStart, gapEnd) {
    var mergedStart = gapStart;
    var mergedEnd = gapEnd;

    var before = FT_findAdjacentFocusTimeEvent(dayEvents, gapStart, 'before');
    if (before) {
        mergedStart = FT_eventMins(before).start;
        FT_removeAdjacentFocusTimeEvent(before, dStr);
        dayEvents.splice(dayEvents.indexOf(before), 1);
    }

    var after = FT_findAdjacentFocusTimeEvent(dayEvents, gapEnd, 'after');
    if (after) {
        mergedEnd = FT_eventMins(after).end;
        FT_removeAdjacentFocusTimeEvent(after, dStr);
        dayEvents.splice(dayEvents.indexOf(after), 1);
    }

    return { start: mergedStart, end: mergedEnd };
}

function FT_findAdjacentFocusTimeEvent(dayEvents, boundaryMins, side) {
    for (var i = 0; i < dayEvents.length; i++) {
        var e = dayEvents[i];
        if (e.status === 'cancelled') continue;
        if (!e.start || !e.start.dateTime || !e.end || !e.end.dateTime) continue;
        if (e.eventType !== 'focusTime' && e.summary !== FT_CONFIG.EVENT_TITLE) continue;

        var mins = FT_eventMins(e);
        if (side === 'before' && mins.end === boundaryMins) return e;
        if (side === 'after' && mins.start === boundaryMins) return e;
    }
    return null;
}

function FT_eventMins(e) {
    var s = new Date(e.start.dateTime);
    var en = new Date(e.end.dateTime);
    return { start: s.getHours() * 60 + s.getMinutes(), end: en.getHours() * 60 + en.getMinutes() };
}

function FT_removeAdjacentFocusTimeEvent(event, dStr) {
    var mins = FT_eventMins(event);
    var label = dStr + ' ' + FT_minsToHHMM(mins.start) + '-' + FT_minsToHHMM(mins.end);

    if (FT_CONFIG.DRY_RUN) {
        FT_log('  [DRY RUN] would merge & remove adjacent Focus Time ' + label);
        return;
    }

    Calendar.Events.remove(FT_CONFIG.CALENDAR_ID, event.id);
    FT_log('  - merged & removed adjacent Focus Time ' + label);
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
// calendar. It does NOT say what changed, so we just re-run the full
// scheduler - guarded by a cooldown (FT_CONFIG.CALENDAR_TRIGGER_COOLDOWN_MINUTES)
// since Focus Time's own writes, and multi-change syncs, could otherwise
// cause rapid repeat runs.
//
// Setup:   run setupFocusTimeCalendarTrigger() once.
// Remove:  run removeFocusTimeCalendarTrigger(), or delete it from the
//          Triggers panel manually.
// You can run this alongside the daily trigger, or use it instead.

function setupFocusTimeCalendarTrigger() {
    removeFocusTimeCalendarTrigger();
    var calendarId = FT_resolveCalendarId();
    ScriptApp.newTrigger('FT_onCalendarChange')
        .forUserCalendar(calendarId)
        .onEventUpdated()
        .create();
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

function FT_onCalendarChange(e) {
    var props = PropertiesService.getScriptProperties();
    var cooldownMs = (FT_CONFIG.CALENDAR_TRIGGER_COOLDOWN_MINUTES || 5) * 60 * 1000;
    var last = Number(props.getProperty('FT_LAST_CALENDAR_TRIGGER_RUN') || 0);
    var now = Date.now();
    if (now - last < cooldownMs) {
        FT_log('Calendar-change trigger fired but skipped (cooldown active, ' +
            Math.round((cooldownMs - (now - last)) / 1000) + 's remaining)');
        return;
    }
    props.setProperty('FT_LAST_CALENDAR_TRIGGER_RUN', String(now));
    FT_log('Calendar-change trigger fired - running scheduleFocusTime()');
    scheduleFocusTime();
}
