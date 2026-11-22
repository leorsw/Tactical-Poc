// net.js — thin WebSocket wrapper for the game client, with auto-reconnect.
// A deploy restart or a mobile network blip must not leave a player on a
// frozen screen: on close, reconnect with backoff (1s, 2s, 4s, 8s cap).
// main.js rejoins with the saved callsign/team on the new connection.

export class GameSocket {
  constructor() {
    this.ws = null;
    this.handlers = new Map(); // message type -> [callbacks]
    this.onOpen = null;
    this.onClose = null;
    this.wantConnection = false; // false after an explicit disconnect()
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
  }

  connect() {
    this.wantConnection = true;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}`);
    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.onOpen && this.onOpen();
    };
    this.ws.onclose = () => {
      this.onClose && this.onClose();
      if (this.wantConnection) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
      }
    };
    this.ws.onerror = () => {
      /* onclose will fire too; nothing special to do here */
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const list = this.handlers.get(msg.t);
      if (list) for (const cb of list) cb(msg);
    };
  }

  disconnect() {
    this.wantConnection = false;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  on(type, cb) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(cb);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
