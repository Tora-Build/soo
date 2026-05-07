// Real end-to-end test: buy YES shares through the AMM page UI, signed by
// LocalKeypairAdapter, verified against on-chain Position state.
//
// Prerequisites (NOT done by this spec):
//   1. solana-test-validator running at $SOLANA_RPC_URL with the four
//      sooth_* program .so binaries deployed at their declare_id! pubkeys
//      (67zS…, ByhA…, HkXe…, 4fif…) and the canonical USDC mint
//      (4zMM…) preloaded via `--account`.
//   2. `pnpm -F @sooth/demo seed:prepare` (writes USDC mint dump JSON)
//      and `pnpm -F @sooth/demo seed:init` (initialises ProtocolConfig +
//      fee_pool_vault + AdjudicatorAllowlist + creates the demo market)
//      have been run against that validator. This produces
//      apps/demo/.env.local with VITE_DEMO_MARKET_REF and
//      apps/demo/.localnet/mint-authority.json.
//   3. VITE_TEST_KEYPAIR_BYTES + TEST_PUBKEY env vars exported (matching
//      a fresh `solana-keygen new -o /tmp/sooth-test-kp.json`).
//
// The Playwright globalSetup hook handles the rest: airdrops SOL to the
// test wallet, mints 1000 USDC via the seed mint authority, and writes
// e2e/.e2e-fixture.json with the resolved market PDA + market_id hex.
//
// What this spec proves:
//   - Wallet connects via the LocalKeypairAdapter (no Phantom popup).
//   - Click on the BUY button submits a real Solana transaction.
//   - The on-chain Position PDA's yes_shares (i128 LE at offset 72) goes
//     from 0 → 10·WAD = 10·10^18.
//   - The user's USDC ATA balance decreases by ~5 USDC + 1% fee
//     (~5_062_500 base units) — bounded between 5.0 and 5.5 USDC.
//   - The UI's position display ("X YES" / "X NO" line) reflects the new
//     position when sell mode is selected.

import { test, expect, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  makeConnection,
  getAccountData,
  getTokenBalance,
  readI128LE,
  waitForOnChainChange,
} from "../helpers/onchain";

// ─── Env / fixture ───────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, "..", ".e2e-fixture.json");

interface Fixture {
  marketPda: string;
  marketIdHex: string;
  soothAmmId: string;
  usdcMint: string;
  rpcUrl: string;
}

function loadFixture(): Fixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `${FIXTURE_PATH} missing — globalSetup did not run or failed`,
    );
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}

// Position layout (mirror of sooth_amm::state::Position; offsets sourced
// from sooth-account-offsets crate at packages/programs-core/crates/
// sooth-account-offsets/src/lib.rs — the on-chain SPACE constants are
// asserted to match these at compile time, so a future field reorder
// trips the build before drifting at runtime):
//
//   offset 0..8     : Anchor discriminator
//   offset 8..40    : user (Pubkey)
//   offset 40..72   : market (Pubkey)
//   offset 72..88   : yes_shares (i128 LE)
//   offset 88..104  : no_shares (i128 LE)
//   offset 104..112 : lock_nonce (u64 LE)
//   offset 112      : bump (u8)
const POSITION_YES_SHARES_OFFSET = 72;

// 10 shares of YES (default amount in SimpleTradingPanel buy mode) →
// 10 * 10^18 in WAD (sooth_amm internal share unit).
const EXPECTED_DELTA_YES_WAD = 10n * 10n ** 18n;

// ─── Browser-side tx hash capture ────────────────────────────────────────
//
// Wraps window.fetch BEFORE first navigation so we can recover the
// confirmed signature from the JSON-RPC `sendTransaction` response. Used
// only on diagnostic failure paths; the spec never asserts via the sig.
async function installTxCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type W = Record<string, unknown>;
    (window as unknown as W).__lastSig = null;
    const origFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      const body = typeof init?.body === "string" ? init.body : "";
      const isSendTx = body.includes('"sendTransaction"');
      const res = await origFetch(...args);
      if (isSendTx) {
        try {
          const clone = res.clone();
          const json = (await clone.json()) as { result?: string };
          if (json.result) (window as unknown as W).__lastSig = json.result;
        } catch {
          /* ignore — body may not be JSON or already consumed */
        }
      }
      return res;
    };
  });
}

async function getLastSig(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as unknown as { __lastSig: string | null }).__lastSig,
  );
}

// ─── The spec ────────────────────────────────────────────────────────────

test.describe("AMM buy-yes (real e2e against solana-test-validator)", () => {
  test("buy 10 YES shares: Position.yes_shares += 10·WAD; USDC debited", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const TEST_PUBKEY = new PublicKey(requireEnv("TEST_PUBKEY"));
    const fixture = loadFixture();
    const conn = makeConnection();
    const marketIdBytes = Buffer.from(fixture.marketIdHex, "hex");
    if (marketIdBytes.length !== 16) {
      throw new Error(
        `marketIdHex must encode 16 bytes; got ${marketIdBytes.length}`,
      );
    }
    const ammProgramId = new PublicKey(fixture.soothAmmId);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pos"), marketIdBytes, TEST_PUBKEY.toBuffer()],
      ammProgramId,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[spec] market=${marketPda.toBase58()} positionPda=${positionPda.toBase58()}`,
    );

    // 1. On-chain BEFORE
    const beforeData = await getAccountData(conn, positionPda);
    const yesBefore = beforeData
      ? readI128LE(beforeData, POSITION_YES_SHARES_OFFSET)
      : 0n;
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    // eslint-disable-next-line no-console
    console.log(`[spec] before yesShares=${yesBefore} usdc=${usdcBefore}`);

    // 2. Browser instrumentation BEFORE first navigation
    await installTxCapture(page);
    const consoleErrors: string[] = [];
    const consoleAll: string[] = [];
    page.on("console", (msg) => {
      const text = `[browser:${msg.type()}] ${msg.text()}`;
      consoleAll.push(text);
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => {
      pageErrors.push(`${e.name}: ${e.message}`);
    });

    // 3. Navigate to the AMM detail page for the seeded market
    await page.goto(`/amm/${marketPda.toBase58()}`);
    await page.waitForLoadState("networkidle");

    // 4. Connect wallet via LocalKeypairAdapter bridge
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error(
          "_connectTestWallet not exposed — TestWalletBridge not mounted (VITE_TEST_MODE not 'true'?)",
        );
      }
      await w._connectTestWallet();
    });

    // 5. Wait for the trading panel to mount + buy button to enable
    await expect(page.getByTestId("trading-panel")).toBeVisible({
      timeout: 15_000,
    });
    // The default render starts BUY/YES/amount=10. Wait for the quote to
    // populate (cost > 0); until then the buy button stays disabled.
    await expect
      .poll(
        async () => (await page.getByTestId("quote-cost").textContent()) ?? "",
        { timeout: 30_000 },
      )
      .toMatch(/\$\d+\.\d/);

    const buyButton = page.getByTestId("buy-button");
    await expect(buyButton).toBeEnabled({ timeout: 30_000 });

    // 6. Fill input with 10 (already default but assert the intent
    // explicitly so future default changes don't silently shift the test).
    const sharesInput = page.getByTestId("shares-input");
    await sharesInput.fill("10");

    // 7. Click BUY
    await buyButton.click();

    // 8. Wait for the on-chain Position to reflect the buy
    let yesAfter: bigint;
    try {
      yesAfter = await waitForOnChainChange(
        async () => {
          const data = await getAccountData(conn, positionPda);
          return data ? readI128LE(data, POSITION_YES_SHARES_OFFSET) : 0n;
        },
        (v) => v > yesBefore,
        90_000,
        1500,
      );
    } catch (timeoutErr) {
      // Diagnostic dump — see SKILL.md "Diagnostic dumps when click does
      // nothing" for the rule-out order: button → tx → revert → wrong PDA.
      const lastSig = await getLastSig(page);
      const ctaDisabled = await buyButton.getAttribute("aria-disabled");
      const ctaText = (await buyButton.textContent())?.trim();
      const toasts = await page
        .locator('[role="status"], [data-sonner-toast], .toaster, .toast')
        .allTextContents();
      throw new Error(
        `[buy-yes] timed out waiting for Position.yes_shares to increase.\n` +
          `  positionPda: ${positionPda.toBase58()}\n` +
          `  CTA text: ${ctaText}\n` +
          `  CTA aria-disabled: ${ctaDisabled}\n` +
          `  __lastSig: ${lastSig ?? "(none — tx never fired)"}\n` +
          `  toasts: ${JSON.stringify(toasts)}\n` +
          `  pageErrors: ${JSON.stringify(pageErrors)}\n` +
          `  consoleErrors (last 5): ${JSON.stringify(consoleErrors.slice(-5))}\n` +
          `  consoleAll (last 10): ${JSON.stringify(consoleAll.slice(-10))}\n` +
          `  original error: ${(timeoutErr as Error).message}`,
      );
    }

    // 9. Exact delta assertion
    expect(yesAfter - yesBefore).toBe(EXPECTED_DELTA_YES_WAD);

    // 10. USDC was debited (between ~5 USDC and ~5.5 USDC for 10 shares
    // against b=1000 USDC at fee_bps=100 = 1%).
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(usdcAfter).toBeLessThan(usdcBefore);
    const usdcDelta = usdcBefore - usdcAfter;
    // Lower bound: pure baseCost ≈ 5.0125 USDC (5_012_500 base units).
    expect(usdcDelta).toBeGreaterThanOrEqual(5_000_000n);
    // Upper bound: baseCost + 1% fee + slippage padding well under 5.5 USDC.
    expect(usdcDelta).toBeLessThan(5_500_000n);

    // 11. UI position reflects the new position. Switch to SELL mode to
    // surface the per-outcome position balance (rendered as "<N> YES" by
    // SimpleTradingPanel.tsx ~L1062). The expected value is the absolute
    // post-trade total in whole shares (yesAfter / WAD), not just the
    // delta — re-runs against an unreset validator carry the prior balance.
    const expectedTotalShares = yesAfter / 10n ** 18n;
    await page.getByTestId("trade-mode-sell").click();
    const sellPositionLine = page.getByTestId("sell-position-balance");
    await expect(sellPositionLine).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const text = (await sellPositionLine.textContent()) ?? "";
          return text;
        },
        { timeout: 30_000 },
      )
      .toMatch(new RegExp(`${expectedTotalShares}[\\s.]+YES`));

    // eslint-disable-next-line no-console
    console.log(
      `[spec] after yesShares=${yesAfter} usdc=${usdcAfter} delta=${usdcDelta}`,
    );
  });
});
