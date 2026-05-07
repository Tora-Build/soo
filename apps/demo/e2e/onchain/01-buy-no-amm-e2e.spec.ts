// buy-no-amm-e2e — same shape as 00-buy-amm-e2e but selects the NO outcome
// before clicking BUY. Asserts Position.no_shares (i128 LE @ offset 88)
// increases by 10·WAD on a fresh outcome side.

import { test, expect, type Page } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import {
  makeConnection,
  getAccountData,
  getTokenBalance,
  readI128LE,
  waitForOnChainChange,
} from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";

const POSITION_NO_SHARES_OFFSET = 88;
const EXPECTED_DELTA_NO_WAD = 10n * 10n ** 18n;

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
          /* ignore */
        }
      }
      return res;
    };
  });
}

test.describe("AMM buy-no (real e2e against solana-test-validator)", () => {
  test("buy 10 NO shares: Position.no_shares += 10·WAD; USDC debited", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const ammProgramId = new PublicKey(fixture.soothAmmId);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pos"), idBytes, TEST_PUBKEY.toBuffer()],
      ammProgramId,
    );

    const beforeData = await getAccountData(conn, positionPda);
    const noBefore = beforeData
      ? readI128LE(beforeData, POSITION_NO_SHARES_OFFSET)
      : 0n;
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);

    await installTxCapture(page);
    page.on("pageerror", (e) =>
      console.error("[browser:pageerror]", e.message),
    );

    await page.goto(`/amm/${marketPda.toBase58()}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet)
        throw new Error("_connectTestWallet not exposed");
      await w._connectTestWallet();
    });

    await expect(page.getByTestId("trading-panel")).toBeVisible({
      timeout: 15_000,
    });

    // Switch to NO outcome before the buy
    await page.getByTestId("outcome-no").click();
    // Confirm BUY mode (default but explicit for clarity)
    await page.getByTestId("trade-mode-buy").click();
    // Wait for quote to populate after outcome flip
    await expect
      .poll(
        async () => (await page.getByTestId("quote-cost").textContent()) ?? "",
        {
          timeout: 30_000,
        },
      )
      .toMatch(/\$\d+\.\d/);

    const buyButton = page.getByTestId("buy-button");
    await expect(buyButton).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("shares-input").fill("10");
    await buyButton.click();

    const noAfter = await waitForOnChainChange(
      async () => {
        const data = await getAccountData(conn, positionPda);
        return data ? readI128LE(data, POSITION_NO_SHARES_OFFSET) : 0n;
      },
      (v) => v > noBefore,
      90_000,
      1500,
    );

    expect(noAfter - noBefore).toBe(EXPECTED_DELTA_NO_WAD);
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(usdcAfter).toBeLessThan(usdcBefore);
    const usdcDelta = usdcBefore - usdcAfter;
    // After spec 00 shifted the book (buying 10 YES first), q_yes is 10·WAD
    // and the NO side trades at slightly under 0.5 USDC, so 10 NO costs a
    // hair below 5 USDC plus the 1% protocol fee. Loosen the lower bound
    // to accommodate the path-dependence; the upper bound still catches
    // gross fee miscalculation.
    expect(usdcDelta).toBeGreaterThanOrEqual(4_900_000n);
    expect(usdcDelta).toBeLessThan(5_500_000n);
  });
});
