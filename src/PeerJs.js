const { EventEmitter } = require('eventemitter3');
const Api = require('./Api');
const Socket = require('./Socket');
const constants = require('./constants');
const {
  CloudHost,
  CloudPort,
  SocketEventType,
  DefaultKey,
  ServerMessageType,
  PeerEventType,
  PeerErrorType,
} = require('./constants');

class PeerJs extends EventEmitter {
  get id() {
    return this._id;
  }

  get options() {
    return this._options;
  }

  get open() {
    return this._open;
  }

  get socket() {
    return this._socket;
  }

  constructor(id, options) {
    super();
    this._destroyed = false; // Connections have been killed
    this._disconnected = false; // Connection to PeerServer killed but P2P connections still active
    this._open = false; // Sockets and such are not yet open.

    let userId;

    // Deal with overloading
    if (id && id.constructor == Object) {
      options = id;
    } else if (id) {
      userId = id.toString();
    }

    options = {
      // debug: 0, // 1: Errors, 2: Warnings, 3: All logs
      host: CloudHost,
      port: CloudPort,
      path: '/',
      key: DefaultKey,
      token: Math.random().toString(36).substr(2),
      ...options,
    };
    this._options = options;

    // Set path correctly.
    if (this._options.path) {
      if (this._options.path[0] !== '/') {
        this._options.path = '/' + this._options.path;
      }
      if (this._options.path[this._options.path.length - 1] !== '/') {
        this._options.path += '/';
      }
    }

    if (this._options.host == constants.CloudHost) this._options.secure = true;

    this._api = new Api(options);
    this._socket = this._createServerConnection();

    if (userId) {
      this._initialize(userId);
    } else {
      this._api
        .retrieveId()
        .then(id => this._initialize(id))
        .catch(error => this._abort(PeerErrorType.ServerError, error));
    }
  }

  _createServerConnection() {
    const socket = new Socket(this._options);

    socket.on(SocketEventType.Message, data => {
      this._handleMessage(data);
    });

    socket.on(SocketEventType.Error, error => {
      this._abort(PeerErrorType.SocketError, error);
    });

    socket.on(SocketEventType.Disconnected, () => {
      if (this.disconnected) {
        return;
      }

      this.emitError(PeerErrorType.Network, 'Lost connection to server.');
      this.disconnect();
    });

    socket.on(SocketEventType.Close, () => {
      if (this.disconnected) {
        return;
      }

      this._abort(
        PeerErrorType.SocketClosed,
        'Underlying socket is already closed.'
      );
    });

    return socket;
  }

  /** Initialize a connection with the server. */
  _initialize(id) {
    this._id = id;
    this.socket.start(id, this._options.token);
  }

  /** Handles messages from the server. */
  _handleMessage(message) {
    const type = message.type;
    const payload = message.payload;
    const peerId = message.src;

    switch (type) {
      case ServerMessageType.Open: // The connection to the server is open.
        this._lastServerId = this.id;
        this._open = true;
        this.emit(PeerEventType.Open, this.id);
        break;
      case ServerMessageType.Error: // Server error.
        this._abort(PeerErrorType.ServerError, payload.msg);
        break;
      case ServerMessageType.IdTaken: // The selected ID is taken.
        this._abort(PeerErrorType.UnavailableID, `ID "${this.id}" is taken`);
        break;
      case ServerMessageType.InvalidKey: // The given API key cannot be found.
        this._abort(
          PeerErrorType.InvalidKey,
          `API KEY "${this._options.key}" is invalid`
        );
        break;
      case ServerMessageType.Leave: // Another peer has closed its connection to this peer.
        console.debug(`Received leave message from ${peerId}`);
        break;
      case ServerMessageType.Expire: // The offer sent to a peer has expired without response.
        this.emitError(
          PeerErrorType.PeerUnavailable,
          `Could not connect to peer ${peerId}`
        );
        break;
      case ServerMessageType.Offer:
        this.emit(PeerEventType.Offer, {
          peer: peerId,
          signal: payload,
        });
        break;
      case ServerMessageType.Answer:
        this.emit(PeerEventType.Answer, {
          peer: peerId,
          signal: payload,
        });
        break;
      case ServerMessageType.Candidate:
        this.emit(PeerEventType.Candidate, {
          peer: peerId,
          signal: payload,
        });
        break;
      default: {
        if (!payload) {
          console.warn(
            `You received a malformed message from ${peerId} of type ${type}`
          );
          return;
        }
        // XXX: emit
        break;
      }
    }
  }

  // connect
  signal(peer, data) {
    if (this.disconnected) {
      console.warn(
        'You cannot connect to a new Peer because you called ' +
          '.disconnect() on this Peer and ended your connection with the ' +
          'server. You can create a new Peer to reconnect, or call reconnect ' +
          'on this peer if you believe its ID to still be available.'
      );
      this.emitError(
        PeerErrorType.Disconnected,
        'Cannot connect to new Peer after disconnecting from server.'
      );
      return;
    }

    if (data.type === 'offer') {
      return this.socket.send({
        type: ServerMessageType.Offer,
        payload: data,
        dst: peer,
      });
    } else if (data.type === 'answer') {
      return this.socket.send({
        type: ServerMessageType.Answer,
        payload: data,
        dst: peer,
      });
    }

    if (data.candidate && data.candidate.candidate) {
      return this.socket.send({
        type: ServerMessageType.Candidate,
        payload: data,
        dst: peer,
      });
    }
  }

  /**
   * Emits an error message and destroys the Peer.
   * The Peer is not destroyed if it's in a disconnected state, in which case
   * it retains its disconnected state and its existing connections.
   */
  _abort(type, message) {
    console.error('Aborting!');

    this.emitError(type, message);

    if (!this._lastServerId) {
      this.destroy();
    } else {
      this.disconnect();
    }
  }

  /** Emits a typed error message. */
  emitError(type, err) {
    console.error('Error:', err);

    let error;

    if (typeof err === 'string') {
      error = new Error(err);
    } else {
      error = err;
    }

    error.type = type;

    this.emit(PeerEventType.Error, error);
  }

  /**
   * Destroys the Peer: closes all active connections as well as the connection
   *  to the server.
   * Warning: The peer can no longer create or accept connections after being
   *  destroyed.
   */
  destroy() {
    if (this.destroyed) {
      return;
    }

    console.debug(`Destroy peer with ID:${this.id}`);

    this.disconnect();
    this._cleanup();

    this._destroyed = true;

    this.emit(PeerEventType.Close);
  }

  /** Disconnects every connection on this peer. */
  _cleanup() {
    this.socket.removeAllListeners();
  }

  /**
   * Disconnects the Peer's connection to the PeerServer. Does not close any
   *  active connections.
   * Warning: The peer can no longer create or accept connections after being
   *  disconnected. It also cannot reconnect to the server.
   */
  disconnect() {
    if (this.disconnected) {
      return;
    }

    const currentId = this.id;

    console.debug(`Disconnect peer with ID:${currentId}`);

    this._disconnected = true;
    this._open = false;

    this.socket.close();

    this._lastServerId = currentId;
    this._id = null;

    this.emit(PeerEventType.Disconnected, currentId);
  }

  /** Attempts to reconnect with the same ID. */
  reconnect() {
    if (this.disconnected && !this.destroyed) {
      console.debug(
        `Attempting reconnection to server with ID ${this._lastServerId}`
      );
      this._disconnected = false;
      this._initialize(this._lastServerId);
    } else if (this.destroyed) {
      throw new Error(
        'This peer cannot reconnect to the server. It has already been destroyed.'
      );
    } else if (!this.disconnected && !this.open) {
      // Do nothing. We're still connecting the first time.
      console.error(
        "In a hurry? We're still trying to make the initial connection!"
      );
    } else {
      throw new Error(
        `Peer ${this.id} cannot reconnect because it is not disconnected from the server!`
      );
    }
  }
}

module.exports = PeerJs;
