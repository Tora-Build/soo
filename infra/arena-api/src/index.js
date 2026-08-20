// soo-arena — the Arena's social backend as a Cloudflare Worker over D1.
//
// Serves /api/arena/* for the demo app: player profiles, wallet sign-in
// (nonce + ed25519 signature -> bearer session), daily claims, reactions,
// comments, and confirmed-play scoring. Wallets and markets are base58
// Solana pubkeys and are case-SENSITIVE: they are validated, compared, and
// stored verbatim — never case-folded.

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

// The demo is served from several origins (workers.dev previews, pages.dev,
// soo.sooth.market, localhost dev servers), so every response — including
// errors — carries permissive CORS. Auth is a bearer token, not a cookie, so
// a wildcard origin leaks nothing.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const NONCE_TTL_SECONDS = 10 * 60;

class ApiError extends Error {
  constructor(status, message, code = "BAD_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
  });

const nowSeconds = () => Math.floor(Date.now() / 1000);
const todayKey = () => new Date().toISOString().slice(0, 10);

// ─── base58 (Solana pubkeys, signatures) ────────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function base58Decode(value) {
  const bytes = [];
  for (const char of value) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

// A well-formed base58 pubkey string; kept verbatim (no case folding).
const isBase58Key = (value) =>
  typeof value === "string" && value.length >= 32 && value.length <= 44 && BASE58_RE.test(value);

const normalizeWallet = (value) => {
  if (!isBase58Key(value)) {
    throw new ApiError(400, "A valid wallet address is required", "INVALID_WALLET");
  }
  return value;
};

const normalizeMarket = (value) => {
  if (!isBase58Key(value)) {
    throw new ApiError(400, "A valid market address is required", "INVALID_MARKET");
  }
  return value;
};

// ─── small utilities ────────────────────────────────────────────────────────

async function parseBody(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(415, "Expected application/json", "INVALID_CONTENT_TYPE");
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ApiError(400, "Invalid JSON body", "INVALID_JSON");
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  data.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Decode(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function defaultHandle(wallet) {
  return `runner_${wallet.slice(0, 6)}`;
}

// ─── players / leaderboard / social reads ───────────────────────────────────

async function ensurePlayer(db, wallet) {
  const now = nowSeconds();
  await db
    .prepare(
      `INSERT INTO arena_players (wallet, handle, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallet) DO NOTHING`,
    )
    .bind(wallet, defaultHandle(wallet), now, now)
    .run();
}

function serializeProfile(row) {
  return {
    wallet: row.wallet,
    handle: row.handle,
    xp: Number(row.xp),
    tickets: Number(row.tickets),
    streak: Number(row.streak),
    plays: Number(row.plays),
    season: Number(row.season),
    lastActiveDay: row.last_active_day,
    lastDailyClaim: row.last_daily_claim,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function getProfile(db, wallet, create = true) {
  if (create) await ensurePlayer(db, wallet);
  const row = await db.prepare("SELECT * FROM arena_players WHERE wallet = ?").bind(wallet).first();
  if (!row && !create) {
    const now = nowSeconds();
    return {
      wallet,
      handle: defaultHandle(wallet),
      xp: 0,
      tickets: 3,
      streak: 0,
      plays: 0,
      season: 1,
      lastActiveDay: null,
      lastDailyClaim: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (!row) throw new ApiError(500, "Player profile could not be loaded", "PROFILE_MISSING");
  return serializeProfile(row);
}

async function getLeaderboard(db) {
  const result = await db
    .prepare(
      `SELECT wallet, handle, xp, streak, plays
       FROM arena_players
       WHERE season = 1
       ORDER BY xp DESC, updated_at ASC
       LIMIT 20`,
    )
    .all();
  return (result.results ?? []).map((row, index) => ({
    rank: index + 1,
    wallet: row.wallet,
    handle: row.handle,
    xp: Number(row.xp),
    streak: Number(row.streak),
    plays: Number(row.plays),
  }));
}

async function getSocial(db, market, wallet) {
  const [reactionResult, sentimentResult, commentCountResult, commentsResult] = await db.batch([
    db
      .prepare(
        `SELECT reaction, COUNT(*) AS count
         FROM arena_reactions WHERE market = ? GROUP BY reaction`,
      )
      .bind(market),
    db
      .prepare(
        `SELECT outcome, COUNT(*) AS count
         FROM arena_plays WHERE market = ? GROUP BY outcome`,
      )
      .bind(market),
    db.prepare("SELECT COUNT(*) AS count FROM arena_comments WHERE market = ?").bind(market),
    db
      .prepare(
        `SELECT c.id, c.wallet, p.handle, c.body, c.created_at
         FROM arena_comments c
         JOIN arena_players p ON p.wallet = c.wallet
         WHERE c.market = ?
         ORDER BY c.created_at DESC
         LIMIT 30`,
      )
      .bind(market),
  ]);

  const reactions = { fire: 0, brain: 0 };
  for (const row of reactionResult.results ?? []) {
    reactions[row.reaction] = Number(row.count);
  }
  const sentiment = { yes: 0, no: 0, total: 0, yesPercent: 0 };
  for (const row of sentimentResult.results ?? []) {
    sentiment[row.outcome] = Number(row.count);
  }
  sentiment.total = sentiment.yes + sentiment.no;
  sentiment.yesPercent = sentiment.total ? Math.round((sentiment.yes / sentiment.total) * 100) : 0;

  let viewerReaction = null;
  if (wallet) {
    viewerReaction =
      (await db
        .prepare("SELECT reaction FROM arena_reactions WHERE wallet = ? AND market = ?")
        .bind(wallet, market)
        .first("reaction")) ?? null;
  }

  const countRow = commentCountResult.results?.[0] ?? { count: 0 };
  return {
    market,
    reactions,
    viewerReaction,
    sentiment,
    commentCount: Number(countRow.count),
    comments: (commentsResult.results ?? []).map((row) => ({
      id: row.id,
      wallet: row.wallet,
      handle: row.handle,
      body: row.body,
      createdAt: Number(row.created_at),
    })),
  };
}

// ─── auth / rate limiting ───────────────────────────────────────────────────

async function requireSession(request, db) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "Sign in with your wallet to continue", "AUTH_REQUIRED");
  const tokenHash = await sha256(token);
  const row = await db
    .prepare("SELECT wallet FROM arena_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, nowSeconds())
    .first();
  if (!row) throw new ApiError(401, "Your arena session expired", "SESSION_EXPIRED");
  return row.wallet;
}

async function rateLimit(db, bucket, limit, windowSeconds) {
  const now = nowSeconds();
  const row = await db
    .prepare("SELECT window_started_at, hits FROM arena_rate_limits WHERE bucket = ?")
    .bind(bucket)
    .first();
  if (!row || now - Number(row.window_started_at) >= windowSeconds) {
    await db
      .prepare(
        `INSERT INTO arena_rate_limits (bucket, window_started_at, hits) VALUES (?, ?, 1)
         ON CONFLICT(bucket) DO UPDATE SET window_started_at = excluded.window_started_at, hits = 1`,
      )
      .bind(bucket, now)
      .run();
    return;
  }
  if (Number(row.hits) >= limit) {
    throw new ApiError(429, "Too many requests. Try again shortly", "RATE_LIMITED");
  }
  await db.prepare("UPDATE arena_rate_limits SET hits = hits + 1 WHERE bucket = ?").bind(bucket).run();
}

// Verifies the wallet's ed25519 signature over the challenge message. The
// wallet string must decode to a real 32-byte ed25519 pubkey (base58 is
// case-sensitive — a case-folded address is not the key and cannot verify),
// and the signature travels as base64 of the raw 64-byte signature.
async function verifyWalletSignature(wallet, message, signatureB64) {
  const publicKey = base58Decode(wallet);
  if (!publicKey || publicKey.length !== 32) {
    throw new ApiError(400, "A valid wallet address is required", "INVALID_WALLET");
  }
  const signature = typeof signatureB64 === "string" ? base64Decode(signatureB64) : null;
  if (!signature || signature.length !== 64) {
    throw new ApiError(400, "A valid wallet signature is required", "INVALID_SIGNATURE");
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new ApiError(401, "The wallet signature is invalid", "SIGNATURE_MISMATCH");
}

// ─── handlers ───────────────────────────────────────────────────────────────

async function handleBootstrap(ctx) {
  const url = new URL(ctx.request.url);
  const walletValue = url.searchParams.get("wallet");
  const marketValue = url.searchParams.get("market");
  const wallet = walletValue ? normalizeWallet(walletValue) : undefined;
  const market = marketValue ? normalizeMarket(marketValue) : undefined;
  const [profile, leaderboard, social] = await Promise.all([
    wallet ? getProfile(ctx.env.ARENA_DB, wallet, false) : Promise.resolve(null),
    getLeaderboard(ctx.env.ARENA_DB),
    market ? getSocial(ctx.env.ARENA_DB, market, wallet) : Promise.resolve(null),
  ]);
  return json({ profile, leaderboard, social });
}

async function handleNonce(ctx) {
  const body = await parseBody(ctx.request);
  const wallet = normalizeWallet(body.wallet);
  const ip = ctx.request.headers.get("CF-Connecting-IP") ?? "local";
  await rateLimit(ctx.env.ARENA_DB, `nonce:${ip}`, 20, 60);
  const nonce = randomToken(18);
  const issuedAt = new Date().toISOString();
  const message = [
    "Sooth Reality Arcade",
    "Sign in to sync your player profile. This request cannot move funds.",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
  const now = nowSeconds();
  await ctx.env.ARENA_DB
    .prepare(
      `INSERT INTO arena_nonces (wallet, nonce, message, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET nonce = excluded.nonce, message = excluded.message,
         expires_at = excluded.expires_at, created_at = excluded.created_at`,
    )
    .bind(wallet, nonce, message, now + NONCE_TTL_SECONDS, now)
    .run();
  return json({ wallet, message, expiresAt: now + NONCE_TTL_SECONDS });
}

async function handleSession(ctx) {
  const body = await parseBody(ctx.request);
  const wallet = normalizeWallet(body.wallet);
  const nonce = await ctx.env.ARENA_DB
    .prepare("SELECT message, expires_at FROM arena_nonces WHERE wallet = ?")
    .bind(wallet)
    .first();
  if (!nonce || Number(nonce.expires_at) <= nowSeconds()) {
    throw new ApiError(410, "The sign-in request expired", "NONCE_EXPIRED");
  }
  await verifyWalletSignature(wallet, nonce.message, body.signature);

  await ensurePlayer(ctx.env.ARENA_DB, wallet);
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  await ctx.env.ARENA_DB.batch([
    ctx.env.ARENA_DB
      .prepare(
        "INSERT INTO arena_sessions (token_hash, wallet, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(tokenHash, wallet, now + SESSION_TTL_SECONDS, now),
    ctx.env.ARENA_DB.prepare("DELETE FROM arena_nonces WHERE wallet = ?").bind(wallet),
  ]);
  ctx.waitUntil(
    ctx.env.ARENA_DB.prepare("DELETE FROM arena_sessions WHERE expires_at <= ?").bind(now).run(),
  );
  return json({
    token,
    expiresAt: now + SESSION_TTL_SECONDS,
    profile: await getProfile(ctx.env.ARENA_DB, wallet),
  });
}

async function handleDaily(ctx) {
  const wallet = await requireSession(ctx.request, ctx.env.ARENA_DB);
  const now = nowSeconds();
  try {
    await ctx.env.ARENA_DB
      .prepare("INSERT INTO arena_daily_claims (wallet, claim_day, created_at) VALUES (?, ?, ?)")
      .bind(wallet, todayKey(), now)
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE constraint")) {
      throw new ApiError(409, "Today's drop is already claimed", "DAILY_ALREADY_CLAIMED");
    }
    throw error;
  }
  return json({
    profile: await getProfile(ctx.env.ARENA_DB, wallet),
    leaderboard: await getLeaderboard(ctx.env.ARENA_DB),
  });
}

async function handleReaction(ctx) {
  const wallet = await requireSession(ctx.request, ctx.env.ARENA_DB);
  const body = await parseBody(ctx.request);
  const market = normalizeMarket(body.market);
  if (body.reaction !== "fire" && body.reaction !== "brain") {
    throw new ApiError(400, "Reaction must be fire or brain", "INVALID_REACTION");
  }
  const existing = await ctx.env.ARENA_DB
    .prepare("SELECT reaction FROM arena_reactions WHERE wallet = ? AND market = ?")
    .bind(wallet, market)
    .first("reaction");
  if (existing === body.reaction) {
    await ctx.env.ARENA_DB
      .prepare("DELETE FROM arena_reactions WHERE wallet = ? AND market = ?")
      .bind(wallet, market)
      .run();
  } else {
    await ctx.env.ARENA_DB
      .prepare(
        `INSERT INTO arena_reactions (wallet, market, reaction, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(wallet, market) DO UPDATE SET reaction = excluded.reaction, updated_at = excluded.updated_at`,
      )
      .bind(wallet, market, body.reaction, nowSeconds())
      .run();
  }
  return json({ social: await getSocial(ctx.env.ARENA_DB, market, wallet) });
}

async function handleComment(ctx) {
  const wallet = await requireSession(ctx.request, ctx.env.ARENA_DB);
  const body = await parseBody(ctx.request);
  const market = normalizeMarket(body.market);
  const text =
    typeof body.body === "string"
      ? body.body.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
      : "";
  if (!text || text.length > 280) {
    throw new ApiError(400, "Comments must contain 1 to 280 characters", "INVALID_COMMENT");
  }
  await rateLimit(ctx.env.ARENA_DB, `comment:${wallet}`, 5, 60);
  await ctx.env.ARENA_DB
    .prepare("INSERT INTO arena_comments (id, wallet, market, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), wallet, market, text, nowSeconds())
    .run();
  return json({ social: await getSocial(ctx.env.ARENA_DB, market, wallet) }, 201);
}

async function handleProfile(ctx) {
  const wallet = await requireSession(ctx.request, ctx.env.ARENA_DB);
  const body = await parseBody(ctx.request);
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,19}$/.test(handle)) {
    throw new ApiError(
      400,
      "Handle must be 3-20 letters, numbers, dots, dashes, or underscores",
      "INVALID_HANDLE",
    );
  }
  await ctx.env.ARENA_DB
    .prepare("UPDATE arena_players SET handle = ?, updated_at = ? WHERE wallet = ?")
    .bind(handle, nowSeconds(), wallet)
    .run();
  return json({
    profile: await getProfile(ctx.env.ARENA_DB, wallet),
    leaderboard: await getLeaderboard(ctx.env.ARENA_DB),
  });
}

// The client reports a confirmed trade with an opaque transaction reference:
// either a base58 Solana signature or the demo shim's synthetic 0x-hex form
// derived from one. The synthetic form is lossy (it keeps only a prefix of
// the signature), so the play cannot be re-fetched from an RPC node here —
// scoring trusts the signed-in session and leans on the tx reference's
// uniqueness, the ticket gate, and rate limiting to keep it honest.
const TX_REF_RE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;

async function handlePlay(ctx) {
  const wallet = await requireSession(ctx.request, ctx.env.ARENA_DB);
  const body = await parseBody(ctx.request);
  const market = normalizeMarket(body.market);
  if (body.outcome !== "yes" && body.outcome !== "no") {
    throw new ApiError(400, "Outcome must be yes or no", "INVALID_OUTCOME");
  }
  if (body.venue !== "amm" && body.venue !== "orderbook") {
    throw new ApiError(400, "Venue must be amm or orderbook", "INVALID_VENUE");
  }
  const chainId = Number(body.chainId);
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new ApiError(400, "A valid chain ID is required", "INVALID_CHAIN");
  }
  if (typeof body.txHash !== "string" || !TX_REF_RE.test(body.txHash)) {
    throw new ApiError(400, "A valid transaction reference is required", "INVALID_TRANSACTION_HASH");
  }
  // Base58 signatures stay verbatim (case-sensitive); only the 0x-hex form
  // is case-insensitive and safe to fold for the uniqueness key.
  const txHash = body.txHash.startsWith("0x") ? body.txHash.toLowerCase() : body.txHash;
  await rateLimit(ctx.env.ARENA_DB, `play:${wallet}`, 20, 60);
  const existing = await ctx.env.ARENA_DB
    .prepare("SELECT xp_awarded FROM arena_plays WHERE tx_hash = ? AND wallet = ?")
    .bind(txHash, wallet)
    .first();
  if (existing) {
    return json({
      duplicate: true,
      xpAwarded: Number(existing.xp_awarded),
      profile: await getProfile(ctx.env.ARENA_DB, wallet),
      leaderboard: await getLeaderboard(ctx.env.ARENA_DB),
      social: await getSocial(ctx.env.ARENA_DB, market, wallet),
    });
  }

  const priorMarket = await ctx.env.ARENA_DB
    .prepare("SELECT 1 AS found FROM arena_plays WHERE wallet = ? AND market = ? LIMIT 1")
    .bind(wallet, market)
    .first();
  const xpAwarded = priorMarket ? 10 : 120;
  try {
    await ctx.env.ARENA_DB
      .prepare(
        `INSERT INTO arena_plays
          (id, wallet, market, outcome, venue, chain_id, tx_hash, xp_awarded, play_day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        wallet,
        market,
        body.outcome,
        body.venue,
        chainId,
        txHash,
        xpAwarded,
        todayKey(),
        nowSeconds(),
      )
      .run();
  } catch (error) {
    if (String(error).includes("NO_TICKETS")) {
      throw new ApiError(402, "You need a play ticket to score this trade", "NO_TICKETS");
    }
    if (String(error).includes("UNIQUE constraint")) {
      return json({ duplicate: true, xpAwarded, profile: await getProfile(ctx.env.ARENA_DB, wallet) });
    }
    throw error;
  }
  return json(
    {
      duplicate: false,
      xpAwarded,
      profile: await getProfile(ctx.env.ARENA_DB, wallet),
      leaderboard: await getLeaderboard(ctx.env.ARENA_DB),
      social: await getSocial(ctx.env.ARENA_DB, market, wallet),
    },
    201,
  );
}

// ─── router ─────────────────────────────────────────────────────────────────

async function dispatch(ctx) {
  if (!ctx.env.ARENA_DB) {
    throw new ApiError(503, "Arena database binding is not configured", "DATABASE_UNAVAILABLE");
  }
  const url = new URL(ctx.request.url);
  // The client composes `${VITE_ARENA_API_BASE}/api/arena/<route>`.
  const match = url.pathname.match(/^\/api\/arena(?:\/(.*))?$/);
  if (!match) throw new ApiError(404, "Arena route not found", "NOT_FOUND");
  const path = (match[1] ?? "").replace(/^\/+|\/+$/g, "");
  const method = ctx.request.method.toUpperCase();
  if (method === "GET" && (path === "" || path === "bootstrap")) return handleBootstrap(ctx);
  if (method === "POST" && path === "nonce") return handleNonce(ctx);
  if (method === "POST" && path === "session") return handleSession(ctx);
  if (method === "POST" && path === "daily") return handleDaily(ctx);
  if (method === "PUT" && path === "reaction") return handleReaction(ctx);
  if (method === "POST" && path === "comments") return handleComment(ctx);
  if (method === "PATCH" && path === "profile") return handleProfile(ctx);
  if (method === "POST" && path === "plays") return handlePlay(ctx);
  throw new ApiError(404, "Arena route not found", "NOT_FOUND");
}

export default {
  async fetch(request, env, executionCtx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const ctx = {
      request,
      env,
      waitUntil: (promise) => executionCtx.waitUntil(promise),
    };
    try {
      return await dispatch(ctx);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: error.message, code: error.code }, error.status);
      }
      console.error("[arena-api] unhandled error", error);
      return json({ error: "Arena service failed unexpectedly", code: "INTERNAL_ERROR" }, 500);
    }
  },
};
