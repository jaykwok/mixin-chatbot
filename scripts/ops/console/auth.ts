// Browser login: a one-time exchange token from the terminal becomes an opaque HttpOnly session cookie.
// Tokens and session ids are kept only as SHA-256 digests; nothing here is ever written to disk or logs.

export interface AuthLimits {
  /** How long a login link stays usable. */
  exchangeMs: number;
  /** A session ends after this long without a user action; polls do not count. */
  idleMs: number;
  /** A session ends this long after login whatever the activity. */
  absoluteMs: number;
}

export const DEFAULT_LIMITS: AuthLimits = { exchangeMs: 5 * 60_000, idleMs: 30 * 60_000, absoluteMs: 8 * 3_600_000 };

export interface SessionView { label: string; createdAt: number; idleExpiresAt: number; expiresAt: number }

interface Session { label: string; createdAt: number; lastActive: number }

const random = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export class Auth {
  /** Differs per console instance, so an old instance's cookie on the same port is simply ignored. */
  readonly cookieName = `mixin_console_${random(6).replace(/[-_]/g, "x")}`;
  readonly #tokens = new Map<string, number>();
  readonly #sessions = new Map<string, Session>();
  readonly #ended = new Set<(label: string) => void>();

  constructor(readonly limits: AuthLimits = DEFAULT_LIMITS, readonly now: () => number = Date.now) {}

  /** Issues a new login token; earlier unused tokens stop working so only the latest printed link logs in. */
  issueToken(): { token: string; expiresAt: number } {
    this.#tokens.clear();
    const token = random(32), expiresAt = this.now() + this.limits.exchangeMs;
    this.#tokens.set(digest(token), expiresAt);
    return { token, expiresAt };
  }

  /** Consumes the token atomically: the first exchange wins, a repeat or expired token gets null. */
  exchange(token: string): { sessionId: string; view: SessionView } | null {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
    const key = digest(token), expiresAt = this.#tokens.get(key);
    if (expiresAt === undefined) return null;
    this.#tokens.delete(key);
    if (this.now() >= expiresAt) return null;
    const sessionId = random(32), now = this.now();
    const session = { label: random(6), createdAt: now, lastActive: now };
    this.#sessions.set(digest(sessionId), session);
    return { sessionId, view: this.#view(session) };
  }

  /** Looks the session up; `touch` (a user action) renews the idle timer, polls pass false. */
  session(sessionId: string | undefined, touch: boolean): SessionView | null {
    if (!sessionId) return null;
    this.sweep();
    const session = this.#sessions.get(digest(sessionId));
    if (!session) return null;
    if (touch) session.lastActive = this.now();
    return this.#view(session);
  }

  revoke(sessionId: string | undefined): void {
    if (sessionId) this.#end(digest(sessionId));
  }

  revokeAll(): void {
    for (const key of [...this.#sessions.keys()]) this.#end(key);
    this.#tokens.clear();
  }

  /** Called with the session's label whenever a session ends (logout, expiry, console exit), to drop what it held. */
  onEnd(listener: (label: string) => void): void {
    this.#ended.add(listener);
  }

  #end(key: string): void {
    const session = this.#sessions.get(key);
    if (!session) return;
    this.#sessions.delete(key);
    for (const listener of this.#ended) listener(session.label);
  }

  #view(session: Session): SessionView {
    const expiresAt = session.createdAt + this.limits.absoluteMs;
    return { label: session.label, createdAt: session.createdAt, idleExpiresAt: Math.min(session.lastActive + this.limits.idleMs, expiresAt), expiresAt };
  }

  /** Ends idle and expired sessions; also run on a timer so a session nobody uses again still ends on time. */
  sweep(): void {
    const now = this.now();
    for (const [key, session] of [...this.#sessions]) if (now >= this.#view(session).idleExpiresAt) this.#end(key);
    for (const [key, expiresAt] of this.#tokens) if (now >= expiresAt) this.#tokens.delete(key);
  }
}
