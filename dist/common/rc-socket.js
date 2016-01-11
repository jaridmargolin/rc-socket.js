/*!
 * rc-socket.js:
 * Originally adapted from: https://github.com/joewalnes/reconnecting-websocket
 */




/* -----------------------------------------------------------------------------
 * export false if WebSocket is hixie
 * http://stackoverflow.com/questions/17849517/check-to-see-if-websocket-is-hixie-client-side
 * ---------------------------------------------------------------------------*/

// if (window.WebSocket && (WebSocket.CLOSED === 3 || WebSocket.prototype.CLOSED === 3)) {
//   return false;
// }


/* -----------------------------------------------------------------------------
 * RcSocket
 * ---------------------------------------------------------------------------*/

/**
 * @global
 * @public
 * @constructor
 *
 * @name RcSocket
 * @desc This behaves like a WebSocket in every way, except if it fails to
 * connect, or it gets disconnected, it will use an exponential backoff until
 * it succesfully connects again.
 *
 * It is API compatible with the standard WebSocket API.
 *
 * @example
 * var ws = new ReconnectingWebsocket(wss://host);
 *
 * @param {String} url - Url to connect to.
 * @param {String|Array} protocols - Optional subprotocols.
 */
var RcSocket = function (url, protocols) {
  this.url = url;
  this.protocols = protocols;

  this.debug = false;
  this.timeout = 2500;
  this.maxRetry = 1000;
  this.delay = 100;
  this.logger = console;

  this.hasUnloaded = false;
  this.hasOpened = false;
  this.wasForced = false;
  this.isRetrying = false;
  this.isRefreshing = false;
  this.attempts = 1;
  this.queue = [];

  // Hack P1: Safegaurd against firefox behavior where close event is
  // triggered on page navigation and results in an attempted reconnect.
  window.onbeforeunload = function () {
    this.hasUnloaded = true;
  }.bind(this);

  // Delay connect so that we can immediately add socket handlers.
  setTimeout(this._connect.bind(this), 0);
};

/**
 * @public
 * @memberof RcSocket
 *
 * @desc Wrapper around ws.send that adds queue functionality when socket is
 *   not in a connected readyState.
 *
 * @example
 * socket.send({ prop: 'val' });
 *
 * @param {Object} data - data to send via web socket.
 */
RcSocket.prototype.send = function (data) {
  // TODO: Seems like we should be checking if readyState is connected?
  if (this.ws && this.readyState) {
    return this.ws.send(data);
  }

  // Add data to end of queue so that when we send queued messages we can loop
  // through in reverse and remove queued as we go.
  this.queue.unshift(data);
};

/**
 * @public
 * @memberof RcSocket
 *
 * @desc Explicitly close socket. Overrides default RcSocket reconnection logic.
 *
 * @example
 * socket.close();
 */
RcSocket.prototype.close = function () {
  this.wasForced = true;
  this._close();
};

/**
 * @public
 * @memberof RcSocket
 *
 * @desc Retry is intended to be called when the socket has yet to connect.
 *   Rather than letting it set indefinetely, we close the socket after a
 *   specified timeout and attempt to reconnect.
 */
RcSocket.prototype.retry = function() {
  this.isRetrying = true;
  this._close();
};

/**
 * @public
 * @memberof RcSocket
 *
 * @desc Refresh the connection if open (close, re-open). If the app suspects
 *   the socket is stale (occurs when changing from wifi -> carrier or vice
 *   versa), this method will close the existing socket and reconnect.
 *
 * @public
 */
RcSocket.prototype.refresh = function() {
  this.isRefreshing = true;
  this._close();
};


/* -----------------------------------------------------------------------------
 * WebSocket Management
 * ---------------------------------------------------------------------------*/

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Wrapper around WebSocket creation. By wrapping the raw WebSocket we
 *   have the opportunity to manipulate events, change behavior (like adding
 *   reconnection logic), and then finally proxy the events as if we were a
 *   the actual socket.
 */
RcSocket.prototype._connect = function () {
  this.ws = new WebSocket(this.url, this.protocols);
  this.ws.onopen = this._onopen.bind(this);
  this.ws.onclose = this._onclose.bind(this);
  this.ws.onmessage = this._onmessage.bind(this);
  this.ws.onerror = this._onerror.bind(this);

  // Attach an id to the internal web socket. Could be use for various reasons
  // but initially being introduced for debugging purposes.
  this.ws.id = Date.now();

  this.connectTimer = setTimeout(function() {
    this._trigger('ontimeout');
    this.retry();
  }.bind(this), this.timeout);

  this._stateChanged('CONNECTING', 'onconnecting');
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Timeout cleanup, state management, and queue handling.
 *
 * @param {Object} evt - WebSocket onopen evt.
 */
RcSocket.prototype._onopen = function (evt) {
  clearTimeout(this.connectTimer);

  // Fix error where close is explicitly called but onopen event is still
  // triggered.
  if (this.wasForced) {
    return this.close();
  }

  this.hasOpened = true;
  this.attempts = 1;
  this._stateChanged('OPEN', 'onopen', evt);
  this._sendQueued();
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Responsible for interpretting the various possible close types (force,
 *   retry, refresh, etc...) and reconnecting/proxying events accordinly.
 *
 * @param {Object} evt - WebSocket onclose evt.
 */
RcSocket.prototype._onclose = function (evt) {
  clearTimeout(this.connectTimer);
  this.ws = null;

  // Because RcSocket holds state we can pass additional information to
  // upstream handlers regarding why the socket was closed.
  evt.forced = this.wasForced;
  evt.isRetrying = this.isRetrying;
  evt.isRefreshing = this.isRefreshing;

  // Immediately change state and exit on force close.
  if (this.wasForced) {
    this._stateChanged('CLOSED', 'onclose', evt);

  // Hack P2: Safegaurd against firefox behavior where close event is
  // triggered on page navigation and results in an attempted reconnect.
  } else if (!this.hasUnloaded) {
    // Was open at some point so we need to trigger close evts
    // TODO: Wondering it state change should ALWAYS BE CALLED?
    if (this.hasOpened) {
      this._trigger('onclose', evt);
    }

    this.isRetrying = false;
    this.isRefreshing = false;
    this.hasOpened = false;
    this._reconnect();
  }
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Simple proxy for onmessage event.
 *
 * @param {Object} evt - WebSocket onmessage evt.
 */
RcSocket.prototype._onmessage = function (evt) {
  this._trigger('onmessage', evt);
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Simple proxy for onerror event.
 *
 * @param {Object} evt - WebSocket onerror evt.
 */
RcSocket.prototype._onerror = function (evt) {
  this._trigger('onerror', evt);
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Helper around ws.close to ensure ws exists. If it does not exist we
 *   fail silently. This seemed logical as closing the socket would have the
 *   same effect as if the socket never existed. In other words no matter what
 *   happens in this method the net effect will always be the same.
 */
RcSocket.prototype._close = function() {
  if (this.ws) {
    this.ws.close();
  }
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Call connect after a delayed timeout. The timeout is calculated using
 *   expotential backoff. As connect attempts increase, the time between connect
 *   attempts will grow (up to a specified maxRetry).
 */
RcSocket.prototype._reconnect = function () {
  var interval = (Math.pow(2, this.attempts) - 1) * 1000;
  interval = (interval > this.maxRetry) ? this.maxRetry : interval;

  this.attempts ++;
  setTimeout(this._connect.bind(this), interval);
};


/* -----------------------------------------------------------------------------
 * Queue
 * ---------------------------------------------------------------------------*/

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Loop over all queued messages and send.
 */
RcSocket.prototype._sendQueued = function () {
  var length = this.queue.length;
  var index = length;

  while (index--) {
    this._delayQueueSend(index, length - index);
  }
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Send delayed message to avoid timing issues when sending queued.
 *
 * @param {integer} index - Index of message in queue to send.
 * @param {integer} delayMultiplier Determined by where the index falls
 *   in respect to the entire queue count.
 */
RcSocket.prototype._delayQueueSend = function (index, delayMultiplier) {
  setTimeout(function () {
    this.send(this.queue[index]);
    this.queue.pop();
  }.bind(this), this.delay * delayMultiplier);
};


/* -----------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------*/

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Update state, log, trigger.
 *
 * @param {String} state - String representing WebSocket.
 * @param {String} name - String of the event name.
 * @param {Object} evt - Event object.
 */
RcSocket.prototype._stateChanged = function (state, evtName, evt) {
  this.readyState = WebSocket[state];
  this._trigger(evtName, evt);
};

/**
 * @private
 * @memberof RcSocket
 *
 * @desc Convenience method for semantically calling handlers.
 *
 * @param {String} evtName - Name of event to fire.
 * @param {Object} evt - Raw WebSocket evt we are proxying.
 */
RcSocket.prototype._trigger = function (evtName, evt) {
  if (this.debug || RcSocket.debugAll) {
    this.logger.debug('RcSocket', evtName, this.url, evt);
  }

  if (this[evtName]) {
    this[evtName](evt);
  }
};


/* -----------------------------------------------------------------------------
 * export
 * ---------------------------------------------------------------------------*/

module.exports = RcSocket;


