// multi-tx-amm-e2e — buy 10 YES then buy 5 YES via the UI in two
// transactions. Asserts the second buy compounds onto the first
// (Position.yes_shares delta = 15·WAD across the test) and USDC drops on
// each click. Confirms the on-chain position accrues, not overwrites.

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

const POSITION_YES_SHARES_OFFSET = 72;

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

test.describe("AMM multi-tx buy compounding", () => {
  test("two sequential buys: first +10·WAD, second +5·WAD; USDC drops twice", async ({
    page,
  }) => {
    test.setTimeout(180_000);
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
    const yesBefore = beforeData
      ? readI128LE(beforeData, POSITION_YES_SHARES_OFFSET)
      : 0n;
    const usdcStart = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);

    await installTxCapture(page);
    await page.goto(`/amm/${marketPda.toBase58()}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      await w._connectTestWallet!();
    });
    await expect(page.getByTestId("trading-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("outcome-yes").click();
    await page.getByTestId("trade-mode-buy").click();

    // ─── Buy #1: 10 YES ───────────────────────────────────────────────
    await expect
      .poll(
        async () => (await page.getByTestId("quote-cost").textContent()) ?? "",
        {
          timeout: 30_000,
        },
      )
      .toMatch(/\$\d+\.\d/);
    let buyButton = page.getByTestId("buy-button");
    await expect(buyButton).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("shares-input").fill("10");
    await buyButton.click();

    const yesAfterFirst = await waitForOnChainChange(
      async () => {
        const data = await getAccountData(conn, positionPda);
        return data ? readI128LE(data, POSITION_YES_SHARES_OFFSET) : 0n;
      },
      (v) => v >= yesBefore + 10n * 10n ** 18n,
      90_000,
      1500,
    );
    expect(yesAfterFirst - yesBefore).toBe(10n * 10n ** 18n);
    const usdcAfterFirst = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(usdcAfterFirst).toBeLessThan(usdcStart);

    // ─── Buy #2: 5 YES on top of the existing position ────────────────
    //
    // The trading panel keeps the previous quote until the input changes;
    // re-fill the input to refresh.
    await page.getByTestId("shares-input").fill("5");
    // Quote refreshes asynchronously; wait until the BUY button toggles
    // back to enabled with a fresh dollar amount.
    await expect
      .poll(
        async () => (await page.getByTestId("quote-cost").textContent()) ?? "",
        {
          timeout: 30_000,
        },
      )
      .toMatch(/\$\d+\.\d/);
    buyButton = page.getByTestId("buy-button");
    await expect(buyButton).toBeEnabled({ timeout: 30_000 });
    await buyButton.click();

    const yesAfterSecond = await waitForOnChainChange(
      async () => {
        const data = await getAccountData(conn, positionPda);
        return data ? readI128LE(data, POSITION_YES_SHARES_OFFSET) : 0n;
      },
      (v) => v >= yesAfterFirst + 5n * 10n ** 18n,
      90_000,
      1500,
    );
    expect(yesAfterSecond - yesAfterFirst).toBe(5n * 10n ** 18n);
    expect(yesAfterSecond - yesBefore).toBe(15n * 10n ** 18n);

    const usdcAfterSecond = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(usdcAfterSecond).toBeLessThan(usdcAfterFirst);
  });
});
