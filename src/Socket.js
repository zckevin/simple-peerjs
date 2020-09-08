const { EventEmitter } = require('eventemitter3');
const { SocketEventType, ServerMessageType } = require('./constants');

class Socket extends EventEmitter {
  constructor(opts) {
    super();
    this._disconnected = true;
    this._messagesQueue = [];
    this.pingInterval = opts.pingInterval;
    const wsProtocol = opts.secure ? 'wss://' : 'ws://';
    this._baseUrl =
      wsProtocol +
      opts.host +
      ':' +
      opts.port +
      opts.path +
      'peerjs?key=' +
      opts.key;
    this._WebSocket = opts.WebSocket || WebSocket;
  }

  start(id, token) {
    this._id = id;

    const wsUrl = `${this._baseUrl}&id=${id}&token=${token}`;

    if (this._socket || !this._disconnected) {
      return;
    }

    this._socket = new this._WebSocket(wsUrl);
    this._disconnected = false;

    this._socket.onmessage = event => {
      let data;

      try {
        data = JSON.parse(event.data);
        console.debug('Server message received:', data);
      } catch (e) {
        console.debug('Invalid server message', event.data);
        return;
      }

      this.emit(SocketEventType.Message, data);
    };

    this._socket.onclose = event => {
      if (this._disconnected) {
        return;
      }

      console.debug('Socket closed.', event);

      this._cleanup();
      this._disconnected = true;

      this.emit(SocketEventType.Disconnected);
    };

    // Take care of the queue of connections if necessary and make sure Peer knows
    // socket is open.
    this._socket.onopen = () => {
      if (this._disconnected) {
        return;
      }

      this._sendQueuedMessages();

      console.debug('Socket open');

      this._scheduleHeartbeat();
    };
  }

  _scheduleHeartbeat() {
    this._wsPingTimer = setTimeout(() => {
      this._sendHeartbeat();
    }, this.pingInterval);
  }

  _sendHeartbeat() {
    if (!this._wsOpen()) {
      console.debug(`Cannot send heartbeat, because socket closed`);
      return;
    }

    const message = JSON.stringify({ type: ServerMessageType.Heartbeat });

    this._socket.send(message);

    this._scheduleHeartbeat();
  }

  /** Is the websocket currently open? */
  _wsOpen() {
    return !!this._socket && this._socket.readyState === 1;
  }

  /** Send queued messages. */
  _sendQueuedMessages() {
    // Create copy of queue and clear it,
    // because send method push the message back to queue if smth will go wrong
    const copiedQueue = [...this._messagesQueue];
    this._messagesQueue = [];

    for (const message of copiedQueue) {
      this.send(message);
    }
  }

  /** Exposed send for DC & Peer. */
  send(data) {
    if (this._disconnected) {
      return;
    }

    // If we didn't get an ID yet, we can't yet send anything so we should queue
    // up these messages.
    if (!this._id) {
      this._messagesQueue.push(data);
      return;
    }

    if (!data.type) {
      this.emit(SocketEventType.Error, 'Invalid message');
      return;
    }

    if (!this._wsOpen()) {
      return;
    }

    const message = JSON.stringify(data);

    this._socket.send(message);
  }

  close() {
    if (this._disconnected) {
      return;
    }

    this._cleanup();

    this._disconnected = true;
  }

  _cleanup() {
    if (!!this._socket) {
      this._socket.onopen = this._socket.onmessage = this._socket.onclose = null;
      this._socket.close();
      this._socket = undefined;
    }

    clearTimeout(this._wsPingTimer);
  }
}

module.exports = Socket;
