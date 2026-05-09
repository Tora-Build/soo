// Reference E2E spec: AMM buy-yes-shares flow against a Solana dApp.
//
// Drop into apps/<your-dapp>/e2e/onchain/buy-amm-e2e.spec.ts. Adjust:
//   - imports of programIds + market PDA
//   - selectors (test ids on your buy form)
//   - the Position struct field offset for `yes_shares`
//
// What this proves:
//   1. Wallet connects via the LocalKeypairAdapter (no Phantom popup).
//   2. The buy button submits a real Solana transaction.
//   3. The on-chain Position PDA's yes_shares field increases by exactly
//      the input amount.
//   4. The user's USDC balance decreases (some amount).
//   5. The UI updates to reflect the new position.
//
// What this does NOT prove (out of scope):
//   - Cost is correct vs LMSR (separate unit test in math/lmsr.test.ts)
//   - Fee router collected the fee (separate spec)
//   - LP mint received pre-graduation tokens (separate spec)

import { test, expect, type Page } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import {
  makeConnection,
  getAccountData,
  getUsdcBalance,
  readU64LE,
  waitForOnChainChange,
} from "../helpers/onchain";

// ────────────────────────────────────────────────────────────────────────
// Config — sourced from env so the spec doesn't hardcode program IDs.
// ────────────────────────────────────────────────────────────────────────

const TEST_PUBKEY = new PublicKey(requireEnv("TEST_PUBKEY"));
const SOOTH_AMM_ID = new PublicKey(requireEnv("SOOTH_AMM_ID"));
const USDC_MINT = new PublicKey(requireEnv("USDC_MINT"));
const MARKET_PDA = new PublicKey(requireEnv("E2E_MARKET_PDA"));
const MARKET_ID_HEX = requireEnv("E2E_MARKET_ID_HEX"); // 16-byte hex
const MARKET_ID_BYTES = Buffer.from(MARKET_ID_HEX, "hex");

// Position layout (byte offsets after the 8-byte Anchor discriminator):
//   0..8:    discriminator
//   8..40:   user (Pubkey)
//   40..72:  market (Pubkey)
//   72..88:  yes_shares (u128 LE — but only the low u64 in our test range)
//   88..104: no_shares (u128)
//   104..112: lock_nonce (u64)
//   112:     bump (u8)
const POSITION_YES_SHARES_OFFSET = 72;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}

function derivePositionPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pos"), MARKET_ID_BYTES, TEST_PUBKEY.toBuffer()],
    SOOTH_AMM_ID,
  );
  return pda;
}

// ────────────────────────────────────────────────────────────────────────
// Browser-side tx hash capture (for diagnostics on failure)
// ────────────────────────────────────────────────────────────────────────

async function installTxCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__lastSig = null;
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const body = typeof args[1]?.body === "string" ? args[1]!.body : "";
      const isSendTx = body.includes('"sendTransaction"');
      const res = await origFetch(...args);
      if (isSendTx) {
        try {
          const clone = res.clone();
          const json = (await clone.json()) as { result?: string };
          if (json.result) (window as any).__lastSig = json.result;
        } catch {
          /* ignore */
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

// ────────────────────────────────────────────────────────────────────────
// The spec
// ────────────────────────────────────────────────────────────────────────

test.describe("AMM buy-yes (e2e against real chain)", () => {
  test("buy 10 YES shares: Position.yes_shares += 10·WAD", async ({ page }) => {
    test.setTimeout(120_000);

    const conn = makeConnection();
    const positionPda = derivePositionPda();

    // 1. Read on-chain state BEFORE
    const beforeData = await getAccountData(conn, positionPda);
    const yesBefore = beforeData
      ? readU64LE(beforeData, POSITION_YES_SHARES_OFFSET)
      : 0n;
    const usdcBefore = await getUsdcBalance(conn, TEST_PUBKEY, USDC_MINT);

    // 2. Browser-side instrumentation (run BEFORE first navigation)
    await installTxCapture(page);
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // 3. Navigate to the AMM detail page
    await page.goto(`/amm/${MARKET_PDA.toBase58()}`);
    await page.waitForLoadState("networkidle");

    // 4. Connect wallet via the LocalKeypairAdapter bridge
    await page.evaluate(() =>
      (
        window as unknown as { _connectTestWallet: () => Promise<void> }
      )._connectTestWallet(),
    );
    // Give the React tree a tick to re-render with the connected state
    await expect(page.getByRole("button", { name: /^buy$/i })).toBeEnabled({
      timeout: 15_000,
    });

    // 5. Fill the buy form and submit
    const sharesInput = page.getByTestId("shares-input");
    // React-controlled input — ensure both input + change events fire
    await sharesInput.fill("10");
    await page.getByRole("button", { name: /^buy$/i }).click();

    // 6. Wait for the on-chain Position to reflect the buy
    let yesAfter: bigint;
    try {
      yesAfter = await waitForOnChainChange(
        async () => {
          const data = await getAccountData(conn, positionPda);
          return data ? readU64LE(data, POSITION_YES_SHARES_OFFSET) : 0n;
        },
        (v) => v > yesBefore,
        60_000,
        1500,
      );
    } catch (timeoutErr) {
      // Diagnostic dump on failure (see SKILL.md §10 "Diagnostic dumps")
      const lastSig = await getLastSig(page);
      const cta = await page
        .getByRole("button", { name: /^buy$/i })
        .getAttribute("aria-disabled");
      const toastText = await page
        .locator('[data-sonner-toast], [role="status"]')
        .allTextContents();
      throw new Error(
        `[buy-yes] timed out waiting for on-chain change.\n` +
          `  CTA aria-disabled: ${cta}\n` +
          `  __lastSig: ${lastSig ?? "(none — tx never fired)"}\n` +
          `  toasts: ${JSON.stringify(toastText)}\n` +
          `  console errors: ${JSON.stringify(consoleErrors.slice(-5))}\n` +
          `  original error: ${(timeoutErr as Error).message}`,
      );
    }

    // 7. Assert exact delta (10 shares = 10 * 10^18 in WAD)
    expect(yesAfter - yesBefore).toBe(10n * 10n ** 18n);

    // 8. Verify USDC was debited
    const usdcAfter = await getUsdcBalance(conn, TEST_PUBKEY, USDC_MINT);
    expect(usdcAfter).toBeLessThan(usdcBefore);
    const usdcDelta = usdcBefore - usdcAfter;
    // For a buy of 10 shares from balanced 50/50 with b=1000 USDC, expect ~5 USDC
    // (closed-form: cost ≈ d/2 + d²/(8b) = 5 + 0.0125 = 5.0125 USDC).
    // Plus 5% fee (per ProtocolConfig.fee_bps default) = ~0.25 USDC.
    expect(usdcDelta).toBeGreaterThan(5_000_000n); // 5 USDC base units
    expect(usdcDelta).toBeLessThan(5_500_000n); // upper bound w/ fee buffer

    // 9. Verify UI reflects the change
    const positionDisplay = page.getByTestId("position-display");
    await expect(positionDisplay).toContainText(/10/, { timeout: 10_000 });
  });
});
