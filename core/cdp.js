export class CdpError extends Error {
  constructor(message, { method, data } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.data = data;
  }
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) {
        reject(new CdpError('CDP connection closed'));
      }
      this.#pending.clear();
    });
  }

  static connect(url, { timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          void 0;
        }
        reject(new CdpError(`Timed out connecting to ${url}`));
      }, timeout);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`Failed to open a WebSocket to ${url}`));
      });
    });
  }

  #onMessage(event) {
    let payload;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }

    if (payload.id != null && this.#pending.has(payload.id)) {
      const { resolve, reject, method } = this.#pending.get(payload.id);
      this.#pending.delete(payload.id);
      if (payload.error) {
        reject(new CdpError(`${method} failed: ${payload.error.message}`, { method, data: payload.error.data }));
      } else {
        resolve(payload.result ?? {});
      }
      return;
    }

    if (payload.method) {
      for (const handler of this.#handlers.get(payload.method) || []) {
        try {
          handler(payload.params ?? {}, payload.sessionId);
        } catch {
          void 0;
        }
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new CdpError('CDP connection closed'));
    const id = this.#nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (err) {
        this.#pending.delete(id);
        reject(new CdpError(`${method} could not be sent: ${err.message}`, { method }));
      }
    });
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(handler);
    return () => this.#handlers.get(method)?.delete(handler);
  }

  once(method, predicate = () => true, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`Timed out waiting for ${method}`));
      }, timeout);
      const off = this.on(method, (params, sessionId) => {
        if (!predicate(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  get closed() {
    return this.#closed;
  }

  close() {
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      void 0;
    }
  }
}
