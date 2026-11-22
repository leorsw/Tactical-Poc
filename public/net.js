// net.js — thin WebSocket wrapper for the game client.

export class GameSocket {
  constructor() {
    this.ws = null;
    this.handlers = new Map(); // message type -> [callbacks]
    this.onOpen = null;
    this.onClose = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}`);
    this.ws.onopen = () => this.onOpen && this.onOpen();
    this.ws.onclose = () => this.onClose && this.onClose();
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
