// faucet-mint-e2e — UI-driven via /faucet.
//
// The faucet dispenses BOTH venue tokens, and each card must top up its own
// mint. One card wired to the wrong mint is invisible in the UI — the toast
// still says success and a balance still moves — but it leaves the wallet
// unable to trade the venue it just funded. So each card is driven separately
// and asserted against its own on-chain ATA, plus the other venue's balance is
// checked to be UNCHANGED, which is what catches a card pointing at the wrong
// mint rather than at nothing.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey } from "../helpers/fixture";

const FAUCET_AMOUNT = 100_000_000_000n;

test.describe("faucet mint (UI-driven)", () => {
  for (const venue of [
    { key: "amm", label: "AMM token", mintField: "ammMint" },
    { key: "book", label: "book token", mintField: "usdcMint" },
  ] as const) {
    test(`${venue.label}: /faucet grows that venue's ATA and leaves the other alone`, async ({
      page,
    }) => {
      test.setTimeout(120_000);

      const fixture = loadFixture();
      const conn = makeConnection();
      const user = testPubkey();

      const target = new PublicKey(fixture[venue.mintField]);
      const other = new PublicKey(
        venue.key === "amm" ? fixture.usdcMint : fixture.ammMint,
      );

      const beforeTarget = await getTokenBalance(conn, target, user);
      const beforeOther = await getTokenBalance(conn, other, user);

      await page.goto(`/faucet`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(async () => {
        const w = window as unknown as {
          _connectTestWallet?: () => Promise<void>;
        };
        if (!w._connectTestWallet) {
          throw new Error("_connectTestWallet not exposed (VITE_TEST_MODE=true?)");
        }
        await w._connectTestWallet();
      });

      const mintButton = page.getByTestId(`faucet-mint-button-${venue.key}`);
      await expect(mintButton).toBeEnabled({ timeout: 15_000 });
      await mintButton.click();

      await expect
        .poll(async () => await getTokenBalance(conn, target, user), {
          timeout: 60_000,
        })
        .toBe(beforeTarget + FAUCET_AMOUNT);

      // The other venue must not have moved. Without this, a card wired to the
      // wrong mint would still pass the assertion above on the run where both
      // cards happen to point at the same token.
      expect(await getTokenBalance(conn, other, user)).toBe(beforeOther);

      // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
      await expect(
        page.locator("text=/Transaction reverted on-chain/i"),
      ).toHaveCount(0);
      await expect(page.locator("text=/Application error/i")).toHaveCount(0);
    });
  }
});
