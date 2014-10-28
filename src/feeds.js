// Copyright 2012 and onwards Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Retrieves and parses a calendar feed from the server.
 * @author manas@google.com (Manas Tungare)
 */

/**
 * The Calendar Feed Parser namespace.
 * @namespace
 */
var feeds = {};

/**
 * URL of the feed that lists all calendars for the current user.
 * @type {string}
 * @const
 * @private
 */
feeds.CALENDAR_LIST_API_URL_ =
    'https://www.googleapis.com/calendar/v3/users/me/calendarList';

feeds.CALENDAR_EVENTS_API_URL_ =
    'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?';

/**
 * The number of days of events to show in the list.
 * @type {number}
 * @const
 * @private
 */
feeds.DAYS_IN_AGENDA_ = 14;

/**
 * All events from visible calendars obtained during the last fetch.
 * @type {Array.<Object>}
 */
feeds.events = [];

/**
 * The event or events that will occur in the immediate future. If this contains
 * more than one event, then all those events must begin at the exact same time
 * and there should be no other event between now and the start time of all of
 * these events.
 * @type {Array.<Object>}
 */
feeds.nextEvents = [];

/**
 * The time at which fresh data was last fetched from the server.
 * @type {Date}
 */
feeds.lastFetchedAt = null;

/**
 * Shows a UI to request an OAuth token. This should only be called in response
 * to user interaction to avoid confusing the user. Since the resulting window
 * is shown with no standard window decorations, it can end up below all other
 * windows, with no way to detect that it was shown, and no way to reposition
 * it either.
 */
feeds.requestInteractiveAuthToken = function() {
  background.log('feeds.requestInteractiveAuthToken()');
  chrome.identity.getAuthToken({'interactive': true}, function (accessToken) {
    if (chrome.runtime.lastError || !authToken) {
      _gaq.push(['_trackEvent', 'OAuth Interactive', 'Not Authorized', chrome.runtime.lastError.message]);
      background.log('OAuth not authorized: ' + chrome.runtime.lastError.message);
      return;
    }
    _gaq.push(['_trackEvent', 'OAuth Interactive', 'Authorized']);
    feeds.refreshUI();  // Causes the badge text to be updated.
    feeds.fetchCalendars();
  });
};


/**
 * Sends a request to fetch the list of calendars for the currently-logged in
 * user. When calendars are received, it automatically initiates a request
 * for events from those calendars.
 */
feeds.fetchCalendars = function() {
  background.log('feeds.fetchCalendars()');
  chrome.extension.sendMessage({method: 'sync-icon.spinning.start'});

  chrome.storage.local.get('calendars', function(storage) {
    if (chrome.runtime.lastError) {
      background.log('Error retrieving settings: ', chrome.runtime.lastError.message);
    }

    var storedCalendars = storage['calendars'] || {};
    chrome.identity.getAuthToken({'interactive': false}, function (authToken) {
      if (chrome.runtime.lastError) {
        _gaq.push(['_trackEvent', 'Fetch', 'Error', chrome.runtime.lastError.message]);
        chrome.extension.sendMessage({method: 'sync-icon.spinning.stop'});
        feeds.refreshUI();
        return;
      }

      _gaq.push(['_trackEvent', 'Fetch', 'CalendarList']);

      $.ajax(feeds.CALENDAR_LIST_API_URL_, {
        headers: {
          'Authorization': 'Bearer ' + authToken
        },
        success: function(data) {
          var calendars = {};
          for (var i = 0; i < data.items.length; i++) {
            var calendar = data.items[i];
            // The list of calendars from the server must be merged with the list of
            // stored calendars. The ID is the key for each calendar feed. The title
            // and color provided by the server override whatever is stored locally
            // (in case there were changes made through the Web UI). Whether the
            // calendar is shown in the browser action popup is determined by a
            // user preference set set locally (via Options) and overrides the
            // defaults provided by the server. If no such preference exists, then
            // a calendar is shown if it's selected and not hidden.

            var serverCalendarID = calendar.id;
            var storedCalendar = storedCalendars[serverCalendarID] || {};

            var visible = (typeof storedCalendar.visible !== 'undefined') ?
                storedCalendar.visible : calendar.selected;

            var mergedCalendar = {
              id: serverCalendarID,
              title: calendar.summary,
              description: calendar.description || '',
              foregroundColor: calendar.foregroundColor,
              backgroundColor: calendar.backgroundColor,
              visible: visible
            };

            calendars[serverCalendarID] = mergedCalendar;
          }

          chrome.storage.local.set({'calendars': calendars}, function() {
            if (chrome.runtime.lastError) {
              background.log('Error saving settings: ', chrome.runtime.lastError.message);
              return;
            }
            feeds.fetchEvents();
          });
        },
        error: function(response) {
          chrome.extension.sendMessage({method: 'sync-icon.spinning.stop'});
          _gaq.push(['_trackEvent', 'Fetch', 'Error', response.statusText]);
          if (response.status === 401) {
            feeds.refreshUI();
            background.log('  - Error 401 fetching list of calendars.');
            chrome.identity.removeCachedAuthToken({ 'token': authToken }, function() {});

          } else {
            window.console.log('An unknown error was encountered in fetching the feed:',
                response);
          }
        }
      });
    });
  });
};

/**
 * Sends a request to the server and retrieves a short list of events occurring
 * in the near future. This only fetches the events and sorts them, it does not
 * populate the global nextEvents list, or update the badge. After events are
 * fetched, it initiates a request to update the UI.
 */
feeds.fetchEvents = function() {
  background.log('feeds.fetchEvents()');
  chrome.extension.sendMessage({method: 'sync-icon.spinning.start'});

  feeds.lastFetchedAt = new Date();
  background.updateBadge({'title': chrome.i18n.getMessage('fetching_feed')});

  chrome.storage.local.get('calendars', function(storage) {
    if (chrome.runtime.lastError) {
      background.log('Error retrieving settings:', chrome.runtime.lastError.message);
      return;
    }

    if (!storage['calendars']) {
      // We don't have any calendars yet? Probably the first time.
      feeds.fetchCalendars();
      return;
    }

    var calendars = storage['calendars'] || {};
    background.log('  - calendars:', calendars);

    var hiddenCalendars = [];
    var allEvents = [];
    var pendingRequests = 0;
    for (var calendarURL in calendars) {
      var calendar = calendars[calendarURL] || {};
      if (typeof calendar.visible !== 'undefined' && calendar.visible) {
        pendingRequests++;
        feeds.fetchEventsFromCalendar_(calendar, function(events) {
          // Merge events from all calendars into a single array.
          if (events) {
            // events can be undefined if the calendar fetch resulted in an HTTP error.
            allEvents = allEvents.concat(events);
          }

          if (--pendingRequests === 0) {
            allEvents.sort(function(first, second) {
              return first.start - second.start;
            });
            feeds.events = allEvents;
            feeds.refreshUI();
          }
        });
      } else {
        hiddenCalendars.push(calendar.title);
      }
    }
    if (hiddenCalendars.length > 0) {
      background.log('Not showing hidden calendars: ', hiddenCalendars);
    }
  });
};


/**
 * Retrieves events from a given calendar from the server.
 * @param {Object} feed A feed object: {title:'', url:'', color:''}.
 * @param {function(?Array.<Object>)} callback A callback called when events
 *     are available.
 * @private
 */
feeds.fetchEventsFromCalendar_ = function(feed, callback) {
  background.log('feeds.fetchEventsFromCalendar_()', feed.title);

  var fromDate = moment();
  var toDate = moment().add('days', feeds.DAYS_IN_AGENDA_);

  var feedUrl = feeds.CALENDAR_EVENTS_API_URL_.replace('{calendarId}', encodeURIComponent(feed.id)) + ([
    'timeMin=' + encodeURIComponent(fromDate.toISOString()),
    'timeMax=' + encodeURIComponent(toDate.toISOString()),
    'maxResults=500',
    'orderBy=startTime',
    'singleEvents=true'
  ].join('&'));

  chrome.identity.getAuthToken({'interactive': false}, function (authToken) {
    if (chrome.runtime.lastError || !authToken) {
      chrome.extension.getBackgroundPage().background.log('OAuth not authorized: ' +
          chrome.runtime.lastError.message);
      chrome.extension.sendMessage({method: 'sync-icon.spinning.stop'});
      feeds.refreshUI();
      return;
    }

    $.ajax(feedUrl, {
      headers: {
        'Authorization': 'Bearer ' + authToken
      },
      success: (function(feed) {
        return function(data) {
          background.log('  - Received events, now parsing.');
          var events = [];
          for (var i = 0; i < data.items.length; i++) {
            var eventEntry = data.items[i];
            var start = utils.fromIso8601(eventEntry.start.dateTime || eventEntry.start.date);
            var end = utils.fromIso8601(eventEntry.end.dateTime || eventEntry.end.date);
            events.push({
              feed: feed,
              title: eventEntry.summary || chrome.i18n.getMessage('event_title_unknown'),
              description: eventEntry.description || '',
              start: start ? start.valueOf() : null,
              end: end ? end.valueOf() : null,
              location: eventEntry.location,
              hangout_url: eventEntry.hangoutLink,
              gcal_url: eventEntry.htmlLink
            });
          }
          callback(events);
        };
      })(feed),
      error: function(response) {
        // Must callback here, otherwise the caller keeps waiting for all
        // calendars to load.
        callback(null);
      }
    });
  });
};


/**
 * Updates the 'minutes/hours/days until' visible badge from the events
 * obtained during the last fetch. Does not fetch new data.
 */
feeds.refreshUI = function() {
  chrome.identity.getAuthToken({'interactive': false}, function (authToken) {
    if (chrome.runtime.lastError || !authToken) {
      background.updateBadge({
        'color': background.BADGE_COLORS.ERROR,
        'text': '×',
        'title': chrome.i18n.getMessage('authorization_required')
      });
      return;
    }
  });

  feeds.removePastEvents_();
  feeds.determineNextEvents_();

  // If there are no more next events to show, bail out.
  if (feeds.nextEvents.length === 0) {
    return;
  }

  if (options.get(options.Options.BADGE_TEXT_SHOWN)) {
    var nextEvent = feeds.nextEvents[0];
    var badgeText = moment(nextEvent.start).lang('relative-formatter').fromNow();

    background.updateBadge({
      'color': nextEvent.feed.backgroundColor,
      'text': badgeText,
      'title': feeds.getTooltipForEvents_(feeds.nextEvents)
    });
  } else {  // User has chosen not to show a badge, but we still set a tooltip.
    background.updateBadge({
      'text': '',
      'title': feeds.getTooltipForEvents_(feeds.nextEvents)
    });
  }

  // Notify the browser action in case it's open.
  chrome.extension.sendMessage({method: 'sync-icon.spinning.stop'});
  chrome.extension.sendMessage({method: 'ui.refresh'});
};


/**
 * Removes events from the global feeds.events list that have already
 * occurred. Events that have started and in progress are retained.
 * @private
 */
feeds.removePastEvents_ = function() {
  // If the last fetch returned no events, it's an empty calendar, so bail out
  // right away. Never request a second fetch, else it will loop infinitely
  // and inundate the server.
  if (feeds.events.length === 0) {
    return;
  }

  // At this point, there are non-zero events present, so it's not a completely
  // empty calendar. Look at the end time instead of the start time, so that
  // events in progress are retained.
  var futureAndCurrentEvents = [];
  for (var i = 0; i < feeds.events.length; ++i) {
    if (feeds.events[i].end > moment().valueOf()) {
      futureAndCurrentEvents.push(feeds.events[i]);
    }
  }
  feeds.events = futureAndCurrentEvents;

  // If there are no more future events left, then fetch a few more & update
  // the badge.
  if (feeds.events.length === 0) {
    feeds.fetchEvents();
  }
};

/**
 * Updates the global feeds.nextEvents list by determining the immediately next
 * event to occur from the global feeds.events list. If more than one event
 * starts at the same time, all of them are included. This is not the list of
 * all future events, just the immediately next ones.
 * @private
 */
feeds.determineNextEvents_ = function() {
  if (feeds.events.length === 0) {
    return;
  }

  feeds.nextEvents = [];
  for (var i = 0; i < feeds.events.length; ++i) {
    if (feeds.events[i].start < moment().valueOf()) {
      continue;  // All-day events for today, or events from earlier in the day.
    }

    if (feeds.nextEvents.length === 0) {
      // If we have not yet found any next events, then pick the first one that
      // is not skipped by the above if-condition.
      feeds.nextEvents.push(feeds.events[i]);
      continue;
    }

    // At this point in the loop, we know there is at least one next event
    // starting at a specific time. Now we need to pick any more events that may
    // exist, that all start at the exact same time as the first event.
    if (feeds.events[i].start == feeds.nextEvents[0].start) {
      feeds.nextEvents.push(feeds.events[i]);
    } else {
      break;
    }
  }
};


/**
 * Returns a formatted tooltip for the badge, given a set of events that all
 * occur at the same time.
 * @param {Array.<Object>} nextEvents A list of events.
 * @return {string} A formatted tooltip.
 * @private
 */
feeds.getTooltipForEvents_ = function(nextEvents) {
  var tooltipLines = [];
  if (nextEvents.length > 0) {
    var startMoment = moment(nextEvents[0].start);
    tooltipLines.push(startMoment.calendar() + ' (' + startMoment.fromNow() + ')');
  }

  for (var i = 0; i < nextEvents.length; i++) {
    var event = nextEvents[i];
    tooltipLines.push(' • ' + event.title + ' (' + event.feed.title + ')');
  }
  return tooltipLines.join('\n');
};
