export type AnyMsg = { t: string } & Record<string, any>;

export class Conn {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private wanted = false;
  private retryTimer: number | undefined;
  onMsg?: (m: AnyMsg) => void;
  onOpen?: () => void;
  onClose?: (willRetry: boolean) => void;

  constructor(public url: string = Conn.resolve()) {}

  static resolve(): string {
    const loc = window.location;
    const qp = new URLSearchParams(loc.search).get('ws');
    if (qp) return qp;
    if (loc.port === '4321') return 'ws://' + loc.hostname + ':8787/ws';
    return (loc.protocol === 'https:' ? 'wss' : 'ws') + '://' + loc.host + '/ws';
  }

  connect() {
    this.wanted = true;
    this.attempts = 0;
    this.openSocket();
  }

  private openSocket() {
    clearTimeout(this.retryTimer);
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    const ws = this.ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let m: AnyMsg;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      this.onMsg?.(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.wanted) this.scheduleRetry();
      this.onClose?.(this.wanted);
    };
    ws.onerror = () => { /* close event carries the retry */ };
  }

  private scheduleRetry() {
    this.attempts++;
    const delay = Math.min(9000, 700 * Math.pow(1.5, Math.min(this.attempts, 8)));
    this.retryTimer = window.setTimeout(() => this.openSocket(), delay);
    this.onClose?.(true);
  }

  get isOpen() { return this.ws?.readyState === 1; }

  send(m: Record<string, unknown>) {
    if (this.ws?.readyState === 1) {
      try { this.ws.send(JSON.stringify(m)); } catch { /* dropped */ }
    }
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      try { this.ws.close(); } catch { /* ok */ }
      this.ws = null;
    }
  }
}
