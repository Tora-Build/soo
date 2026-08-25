/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sooth_core.json`.
 */
export type SoothCore = {
  "address": "EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw",
  "metadata": {
    "name": "soothCore",
    "version": "0.0.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "acceptAuthority",
      "docs": [
        "Take the protocol authority seat this config nominated you for."
      ],
      "discriminator": [
        107,
        86,
        198,
        91,
        33,
        12,
        107,
        160
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newAuthority",
          "docs": [
            "The nominee. Its signature is the whole point of the second step: it",
            "proves the key that is about to own the protocol exists and is",
            "controlled, which a one-step setter cannot establish."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "attestOutcome",
      "discriminator": [
        115,
        210,
        81,
        230,
        222,
        14,
        85,
        209
      ],
      "accounts": [
        {
          "name": "adjudicatorEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Read-only: attestation does not change the lifecycle. `settle` does",
            "that, after the veto window."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "winningOutcome",
          "type": "u8"
        }
      ]
    },
    {
      "name": "attestOutcomeZk",
      "docs": [
        "Record an outcome derived from a verified Primus zkTLS attestation.",
        "Permissionless: the attestation carries its own authority. Like",
        "`attest_outcome` it records only — `settle` still finalizes after the",
        "veto window, so `dispute` remains available against a bad attestation."
      ],
      "discriminator": [
        106,
        199,
        227,
        243,
        107,
        125,
        46,
        196
      ],
      "accounts": [
        {
          "name": "adjudicatorEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Mutable for ONE transition: a pre-deadline attestation that proves",
            "the rule satisfied performs Open → Locked itself. Settlement still",
            "belongs to `settle`, after the veto window."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "submitter",
          "docs": [
            "Fee payer only. This instruction is permissionless by design — the",
            "attestation carries its own authority, so gating submission on a",
            "signer would reintroduce exactly the trusted party being removed."
          ],
          "signer": true
        }
      ],
      "args": [
        {
          "name": "attestation",
          "type": {
            "defined": {
              "name": "zkAttestation"
            }
          }
        }
      ]
    },
    {
      "name": "bookCancel",
      "docs": [
        "Cancel a resting book order; the escrow lands in the owner's seat",
        "credit. See `book_ops`."
      ],
      "discriminator": [
        188,
        129,
        42,
        161,
        150,
        10,
        3,
        59
      ],
      "accounts": [
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "orderSeq",
          "type": "u64"
        }
      ]
    },
    {
      "name": "bookGrow",
      "docs": [
        "Extend the book toward `wanted_capacity`, one realloc step per call."
      ],
      "discriminator": [
        243,
        106,
        1,
        169,
        190,
        123,
        193,
        203
      ],
      "accounts": [
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wantedCapacity",
          "type": "u16"
        }
      ]
    },
    {
      "name": "bookInit",
      "docs": [
        "Create the per-market book. See `book_init`."
      ],
      "discriminator": [
        71,
        248,
        196,
        177,
        97,
        141,
        21,
        244
      ],
      "accounts": [
        {
          "name": "book",
          "docs": [
            "the discriminator."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "initialCapacity",
          "type": "u16"
        }
      ]
    },
    {
      "name": "bookPlace",
      "docs": [
        "Place an order on the book. See `book_place` module docs."
      ],
      "discriminator": [
        166,
        211,
        8,
        100,
        130,
        30,
        212,
        203
      ],
      "accounts": [
        {
          "name": "book",
          "docs": [
            "length; the PDA seeds bind it to this market."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultBook",
          "writable": true
        },
        {
          "name": "takerUsdcAta",
          "writable": true
        },
        {
          "name": "feePoolBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "taker",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "limitTick",
          "type": "u16"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "matchLimit",
          "type": "u32"
        },
        {
          "name": "postRemainder",
          "type": "bool"
        }
      ]
    },
    {
      "name": "bookWithdraw",
      "docs": [
        "Move accumulated seat credit into the caller's wallet."
      ],
      "discriminator": [
        138,
        127,
        40,
        44,
        99,
        47,
        107,
        106
      ],
      "accounts": [
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultBook",
          "writable": true
        },
        {
          "name": "userUsdcAta",
          "writable": true
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claimRefund",
      "discriminator": [
        15,
        16,
        30,
        161,
        255,
        228,
        97,
        60
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "docs": [
            "AMM state for this market. Must be dismissed.",
            "",
            "`mut` for exactly one write: the paid claim leaves",
            "`refund_obligation_usdc`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "docs": [
            "Vault authority signer-only PDA."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "marketVault",
          "writable": true
        },
        {
          "name": "userAmmAta",
          "writable": true
        },
        {
          "name": "position",
          "docs": [
            "AMM Position account — closed by the inline `close_dismissed_position`."
          ],
          "writable": true
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claimUnlocked",
      "discriminator": [
        70,
        139,
        1,
        246,
        166,
        193,
        64,
        143
      ],
      "accounts": [
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "position",
            "lockEntry"
          ]
        },
        {
          "name": "position",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "lockEntry",
          "docs": [
            "Lock entry to drain + close. Anchor's `close = user` refunds the",
            "rent lamports to `user` and zeroes the discriminator on success."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              },
              {
                "kind": "account",
                "path": "lock_entry.nonce",
                "account": "lockEntry"
              }
            ]
          }
        },
        {
          "name": "lockAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lockVault",
          "writable": true
        },
        {
          "name": "userAmmAta",
          "writable": true
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "user",
          "writable": true,
          "signer": true,
          "relations": [
            "position",
            "lockEntry"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closeMarket",
      "discriminator": [
        88,
        154,
        248,
        186,
        48,
        14,
        123,
        244
      ],
      "accounts": [
        {
          "name": "market",
          "docs": [
            "program owns it and deserializes it as a `Market` manually. It is",
            "deliberately NOT `Account<Market>`: Anchor would re-serialize the full",
            "struct on exit, and this handler shrinks the account to 8 bytes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "book",
          "docs": [
            "The book arena, for graduated markets. Optional because a market that",
            "never graduated never allocated one.",
            "",
            "its lamports manually (it is a raw zero-copy account, not an Anchor",
            "`Account`, so `close =` cannot apply)."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "vaultBook",
          "writable": true
        },
        {
          "name": "vaultAmm",
          "writable": true
        },
        {
          "name": "lockVault",
          "writable": true
        },
        {
          "name": "feePoolAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "feePoolBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "lpYieldAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "lpYieldBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "lockAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "feePoolAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "lpYieldAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "creator",
          "docs": [
            "The market's creator — verified against the Market account in the",
            "handler. Signs, and receives every reclaimed lamport."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "marketId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "createMarket",
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "config",
          "docs": [
            "Global protocol config. Checked for `paused` flag."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.market_id"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.market_id"
              }
            ]
          }
        },
        {
          "name": "lockAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "arg",
                "path": "args.market_id"
              }
            ]
          }
        },
        {
          "name": "bookMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "vaultBook",
          "writable": true
        },
        {
          "name": "vaultAmm",
          "docs": [
            "`vault_authority`; created and initialized in the handler, which",
            "re-derives the address before signing.",
            "",
            "Its own PDA, NOT an ATA. The book vault is the vault authority's ATA,",
            "and an ATA is one account per (authority, mint) pair: a deployment that",
            "fills both venue roles with the same mint would collapse the two vaults",
            "into one and merge venue accounting. Own seeds keep the vaults distinct",
            "under any mint pairing, while the token-account authority stays",
            "`vault_authority`, so every downstream transfer path signs identically."
          ],
          "writable": true
        },
        {
          "name": "lockVault",
          "writable": true
        },
        {
          "name": "ammState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "arg",
                "path": "args.market_id"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createMarketArgs"
            }
          }
        }
      ]
    },
    {
      "name": "dismissMarket",
      "discriminator": [
        138,
        225,
        164,
        155,
        53,
        68,
        6,
        26
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "creator",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "dispute",
      "discriminator": [
        216,
        92,
        128,
        146,
        202,
        85,
        135,
        73
      ],
      "accounts": [
        {
          "name": "adjudicatorEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Read-only: a veto changes the outcome, not the lifecycle."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "disputer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newOutcome",
          "type": "u8"
        }
      ]
    },
    {
      "name": "distributeFeesAmm",
      "discriminator": [
        109,
        158,
        217,
        144,
        163,
        159,
        28,
        145
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "feePoolAuthority",
          "docs": [
            "account."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "venueMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "feePool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "bBaseYieldVault",
          "docs": [
            "The venue's own collateral vault: the `b_base` share stays with the",
            "market rather than leaving it.",
            "",
            "NOTE this deepens the vault; it does NOT raise `AmmState.b`. Growing",
            "`b` from fees is the EVM design's mechanism and is not implemented",
            "here, so the honest behaviour is to return the share to the collateral",
            "it came from. `reclaim_subsidy` cannot hand it to the creator — that is",
            "capped at what they actually posted."
          ],
          "writable": true
        },
        {
          "name": "lpYieldAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "docs": [
            "The market's LP mint — read for its SUPPLY. Yield paid into the vault",
            "after the last LP has burned is unclaimable forever (`redeem_lp` needs",
            "a holder to exist), and it would block `close_market` forever too. So",
            "when supply is zero the LP slice folds into the protocol remainder",
            "instead: the last LP out forfeits nothing they were owed — the fees",
            "arriving now were earned after they exited.",
            "",
            "This fold covers fees arriving AFTER supply hit zero. Anything already",
            "sitting in the vault when it did is recovered by `sweep_lp_yield`, to",
            "the same destination — one rule, applied at both moments."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldVault",
          "docs": [
            "THIS market's AMM-side yield vault — the same account `redeem_lp`",
            "pays LP holders from, so the share lands where the claim path expects",
            "it. Seeded by market_id: a global vault here would allow cross-market",
            "theft, since redeem pays out against one market's LP supply."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorFeeVault",
          "docs": [
            "The market's own adjudicator, from `Market`. Not a caller-supplied",
            "address."
          ],
          "writable": true
        },
        {
          "name": "protocolTreasuryVault",
          "docs": [
            "`config.treasury` is the treasury's OWNER, not one token account.",
            "",
            "Bound by authority rather than `address = config.treasury` because",
            "with two venues a single pinned account cannot satisfy",
            "`token::mint = venue_mint` for two different mints — whichever venue",
            "the treasury account did not hold could never distribute, and its pool",
            "would fill and never drain. Binding the authority pins the destination",
            "just as tightly (the caller still cannot choose an owner) while",
            "letting the treasury hold one account per venue."
          ],
          "writable": true
        },
        {
          "name": "cranker",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "distributeFeesBook",
      "discriminator": [
        84,
        180,
        94,
        218,
        48,
        55,
        103,
        77
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "feePoolAuthority",
          "docs": [
            "account."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "venueMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "feePool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "docs": [
            "The market's LP mint — read for its SUPPLY. Yield paid into the vault",
            "after the last LP has burned is unclaimable forever (`redeem_lp` needs",
            "a holder to exist), and it would block `close_market` forever too. So",
            "when supply is zero the LP slice folds into the protocol remainder",
            "instead: the last LP out forfeits nothing they were owed — the fees",
            "arriving now were earned after they exited.",
            "",
            "This fold covers fees arriving AFTER supply hit zero. Anything already",
            "sitting in the vault when it did is recovered by `sweep_lp_yield`, to",
            "the same destination — one rule, applied at both moments."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldVault",
          "docs": [
            "THIS market's book-side yield vault, in the BOOK's token. `redeem_lp`",
            "pays from both venues' vaults in one burn, so this balance has a",
            "claim path — and it is per-market for the same reason the AMM's is:",
            "a global vault would let one market's LPs take every market's yield."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorFeeVault",
          "docs": [
            "The market's own adjudicator, from `Market`."
          ],
          "writable": true
        },
        {
          "name": "protocolTreasuryVault",
          "docs": [
            "The treasury's OWNER — see the AMM's counterpart. `address =` here",
            "would make this venue and the AMM's mutually exclusive."
          ],
          "writable": true
        },
        {
          "name": "cranker",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "forceInvalidAttestation",
      "docs": [
        "Write `INVALID` onto a market whose adjudicator never attested, once",
        "`settle::ABANDONED_MARKET_TIMEOUT_SECS` has passed since its deadline.",
        "Permissionless, and does NOT settle: the ordinary veto window and the",
        "ordinary `settle` still stand between it and a final outcome. See",
        "`instructions/settle.rs`."
      ],
      "discriminator": [
        169,
        247,
        145,
        58,
        211,
        254,
        248,
        148
      ],
      "accounts": [
        {
          "name": "market",
          "docs": [
            "Read-only. Forcing an attestation changes no lifecycle — `settle`",
            "still does that, after the veto window, exactly as for an outcome an",
            "adjudicator wrote."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorEntry",
          "docs": [
            "account, in which case the handler creates it. When it does exist the",
            "handler verifies the owner, the discriminator, the stored `market` and",
            "the stored bump before writing."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "cranker",
          "docs": [
            "Whoever cranks it. Unconstrained by design: the whole point is that no",
            "key is required, because the key that was supposed to act is gone.",
            "",
            "`mut` because it pays the entry's rent on the orphaned-market path."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initMarketFeePool",
      "discriminator": [
        51,
        19,
        251,
        120,
        171,
        91,
        138,
        115
      ],
      "accounts": [
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "feePoolAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "bookMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "feePoolBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "feePoolAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "lpYieldAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeProtocol",
      "discriminator": [
        188,
        233,
        252,
        106,
        134,
        146,
        202,
        91
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeProtocolArgs"
            }
          }
        }
      ]
    },
    {
      "name": "lockForResolution",
      "discriminator": [
        218,
        72,
        208,
        132,
        202,
        195,
        86,
        239
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorEntry",
          "docs": [
            "Per-market adjudicator record. Bound to `market` via seed derivation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "authority",
          "docs": [
            "Authority that may request a lock. Must be `adjudicator_entry.authority`."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "pause",
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "publishResolutionCommitment",
      "docs": [
        "Commit to a T\\* voiding computation for a market. Adjudicator-signed,",
        "accepted only inside the veto window. See `publish_resolution`."
      ],
      "discriminator": [
        103,
        217,
        40,
        223,
        240,
        230,
        159,
        239
      ],
      "accounts": [
        {
          "name": "resolutionCommitment",
          "docs": [
            "One per market, created once. `init` (not `init_if_needed`) is the",
            "one-shot guard."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  111,
                  108,
                  117,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Read-only: a commitment changes no lifecycle. `settle` still does that."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorEntry",
          "docs": [
            "Supplies the attestation timestamp the veto window is measured from,",
            "and the authority allowed to publish."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ammState",
          "docs": [
            "Read-only. Supplies the outstanding share ledger the solvency bound",
            "below is computed against."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAmm",
          "docs": [
            "The cash the AMM's claims are payable from. Read-only — publication",
            "moves no money; it only refuses to promise more than this holds."
          ]
        },
        {
          "name": "book",
          "docs": [
            "never graduated has no book account. Emptiness is read as \"no book",
            "obligations\", and a commitment that claims a book refund on such a",
            "market is refused rather than believed."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultBook"
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "publishResolutionCommitmentArgs"
            }
          }
        }
      ]
    },
    {
      "name": "reclaimSubsidy",
      "docs": [
        "Return the unspent LMSR subsidy to the creator after settlement.",
        "See `reclaim_subsidy`."
      ],
      "discriminator": [
        168,
        145,
        161,
        63,
        204,
        185,
        19,
        152
      ],
      "accounts": [
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "ammState",
            "lpPosition"
          ]
        },
        {
          "name": "ammState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "creator"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAmm",
          "docs": [
            "The AMM vault, and only the AMM vault.",
            "",
            "The subsidy was posted in the AMM token by `seed_lp`, so it is returned",
            "from the same pot. The book's vault holds a different mint and cannot",
            "be touched here even by mistake — an SPL token account holds one mint,",
            "and `address` pins which account this is."
          ],
          "writable": true
        },
        {
          "name": "creatorAmmAta",
          "writable": true
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true,
          "relations": [
            "lpPosition"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "redeemAmmPosition",
      "docs": [
        "Pay out a settled AMM position.",
        "",
        "`voided_claim` is `Some` exactly when the market carries a published",
        "`ResolutionCommitment` — the T\\* voiding path. Every other market",
        "passes `None` and is paid precisely as it was before that path existed."
      ],
      "discriminator": [
        92,
        181,
        19,
        9,
        129,
        83,
        242,
        234
      ],
      "accounts": [
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "ammState",
          "docs": [
            "Decremented as shares are redeemed, so `q_<side> - seed_q_<side>`",
            "always equals the winning shares still unclaimed. `sweep_residual`",
            "gates on that difference reaching zero — without this bookkeeping the",
            "vault's post-settlement surplus is indistinguishable from money still",
            "owed to a slow claimant, and could never be swept."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "position",
          "docs": [
            "Deliberately NOT `close = user` — see module docs."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "userAmmAta",
          "writable": true
        },
        {
          "name": "resolutionCommitment",
          "docs": [
            "`Account<'_, ResolutionCommitment>` would fail every ordinary market's",
            "redemption. The seeds pin the address, so an empty account here is",
            "proof of absence rather than an omission the caller chose; the handler",
            "checks the owner and discriminator before reading a live one."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  111,
                  108,
                  117,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "voidedClaim",
          "type": {
            "option": {
              "defined": {
                "name": "voidedClaimArgs"
              }
            }
          }
        }
      ]
    },
    {
      "name": "redeemBookSeat",
      "docs": [
        "Pay out a winning book seat position after settlement. See",
        "`redeem_book_seat`."
      ],
      "discriminator": [
        223,
        169,
        221,
        254,
        27,
        129,
        68,
        238
      ],
      "accounts": [
        {
          "name": "book",
          "docs": [
            "length; the PDA seeds bind it to this market."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultBook",
          "writable": true
        },
        {
          "name": "userUsdcAta",
          "writable": true
        },
        {
          "name": "resolutionCommitment",
          "docs": [
            "`Account<'_, ResolutionCommitment>` would fail every ordinary market's",
            "redemption. The seeds pin the address, so an empty account here is",
            "proof of absence rather than an omission the caller chose; the handler",
            "checks the owner and discriminator before reading a live one."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  111,
                  108,
                  117,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "voidedClaim",
          "type": {
            "option": {
              "defined": {
                "name": "voidedBookClaimArgs"
              }
            }
          }
        }
      ]
    },
    {
      "name": "redeemLp",
      "discriminator": [
        12,
        99,
        190,
        72,
        228,
        108,
        109,
        164
      ],
      "accounts": [
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "userLpAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "lpMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "lpYieldAmm",
          "docs": [
            "THIS market's AMM-side yield vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldBook",
          "docs": [
            "THIS market's book-side yield vault, in the book's token."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "userAmmAta",
          "writable": true
        },
        {
          "name": "userBookAta",
          "writable": true
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "lpAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerAdjudicator",
      "discriminator": [
        112,
        204,
        98,
        86,
        215,
        36,
        55,
        192
      ],
      "accounts": [
        {
          "name": "adjudicatorEntry",
          "docs": [
            "New per-market `AdjudicatorEntry` PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "authority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "registerZkAdjudicator",
      "docs": [
        "Register a per-market adjudicator that resolves from a Primus zkTLS",
        "attestation rather than a human signature. Separate from",
        "`register_adjudicator` so the manual path is untouched, and so zk mode",
        "is fixed at creation rather than switchable under a live market."
      ],
      "discriminator": [
        116,
        53,
        214,
        178,
        55,
        188,
        229,
        24
      ],
      "accounts": [
        {
          "name": "adjudicatorEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "registerZkAdjudicatorArgs"
            }
          }
        }
      ]
    },
    {
      "name": "requestLock",
      "discriminator": [
        184,
        126,
        124,
        46,
        186,
        78,
        238,
        67
      ],
      "accounts": [
        {
          "name": "adjudicatorEntry",
          "docs": [
            "the account list so callers built against the old IDL still work.",
            "",
            "It may be ABSENT. It used to be a typed `Account`, on the reasoning",
            "that a market with no registered adjudicator can never be attested, so",
            "locking it would only freeze it sooner. That reasoning inverted when",
            "`force_invalid_attestation` learned to create the entry itself: the",
            "hatch requires `Locked`, so refusing to lock an entry-less market was",
            "the last thing keeping an orphaned market's funds immobile. Locking is",
            "now the FIRST step of the rescue, not a way to deepen the hole.",
            "",
            "Nothing is loosened by the change: this instruction checks no",
            "signature, reads no field of the entry, and its own guard — an `Open`",
            "market past its advertised deadline — is untouched. When the entry",
            "does exist the handler still pins it to this market."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "authority",
          "docs": [
            "Any signer. Present so the transaction has a fee payer; the account",
            "list is unchanged from the adjudicator-only version so callers built",
            "against the old IDL keep working."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "revokeResolutionCommitment",
      "docs": [
        "Withdraw a published commitment inside the veto window, restoring the",
        "market's ordinary payout. The dispute authority's veto over the",
        "entitlement tree, mirroring `dispute`'s veto over the outcome."
      ],
      "discriminator": [
        236,
        5,
        86,
        143,
        109,
        122,
        116,
        184
      ],
      "accounts": [
        {
          "name": "resolutionCommitment",
          "docs": [
            "Closed, with the rent returned to whoever paid it. Closing is the",
            "whole point: `redeem_amm_position` reads an absent account as \"no",
            "voiding\", so revocation restores the market's pre-commitment payout",
            "without needing a flag anywhere."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  111,
                  108,
                  117,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorEntry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "publisher",
          "docs": [
            "Refunding anyone else would let a revoker pay themselves out of the",
            "publisher's deposit."
          ],
          "writable": true
        },
        {
          "name": "disputeAuthority",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "seedLp",
      "discriminator": [
        94,
        237,
        13,
        38,
        220,
        124,
        66,
        94
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "docs": [
            "`mut` for exactly one write: `is_seeded`, which opens the trading",
            "paths. Nothing else in this instruction touches `AmmState`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpMintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "creatorLpAta",
          "writable": true
        },
        {
          "name": "lpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "creator"
              }
            ]
          }
        },
        {
          "name": "marketVault",
          "writable": true
        },
        {
          "name": "creatorAmmAta",
          "writable": true
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "seedLpArgs"
            }
          }
        }
      ]
    },
    {
      "name": "sellPositions",
      "discriminator": [
        3,
        151,
        9,
        138,
        95,
        252,
        50,
        39
      ],
      "accounts": [
        {
          "name": "market",
          "docs": [
            "`mut` for exactly one write: `book_enabled` is flipped here when the",
            "sell's fee carries the graduation odometer over its threshold. Nothing",
            "else in this instruction touches `Market`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "ammState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "position",
          "docs": [
            "Per-(user, market) Position. Must already exist — you can only",
            "sell shares you've previously bought."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lockAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "marketVault",
          "writable": true
        },
        {
          "name": "lockVault",
          "writable": true
        },
        {
          "name": "lockEntry",
          "docs": [
            "New `LockEntry` PDA. Seeds `[b\"lock_entry\", position.key(), lock_nonce.to_le_bytes()]`.",
            "The `lock_nonce` instruction parameter must equal `position.lock_nonce`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              },
              {
                "kind": "arg",
                "path": "lockNonce"
              }
            ]
          }
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feePoolAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "user",
          "writable": true,
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "deltaShares",
          "type": "i128"
        },
        {
          "name": "minProceedsWad",
          "type": "u128"
        },
        {
          "name": "lockNonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settle",
      "docs": [
        "Finalize an attested market. Permissionless once the veto window has",
        "closed; the outcome comes from the `AdjudicatorEntry`, not the caller."
      ],
      "discriminator": [
        175,
        42,
        185,
        87,
        144,
        131,
        102,
        212
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "adjudicatorEntry",
          "docs": [
            "Per-market adjudicator record; supplies the attested outcome and",
            "timestamp."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  106,
                  117,
                  100,
                  105,
                  99,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "cranker",
          "docs": [
            "Whoever cranks the settle. Unconstrained by design — see module docs.",
            "Present only so the transaction has a signer to pay fees."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "sweepLpYield",
      "docs": [
        "Recover an LP-yield balance that no LP token can claim, so the market",
        "can still reach the all-zero balances `close_market` requires.",
        "Permissionless; destinations pinned by `config.treasury`."
      ],
      "discriminator": [
        109,
        46,
        123,
        73,
        234,
        119,
        45,
        130
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "docs": [
            "Read for `is_graduated` / `is_dismissed` — half the gate that proves",
            "LP minting has stopped."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "docs": [
            "Read for its SUPPLY, which must be zero. Bound by seeds: an unbound",
            "mint would let a caller present any zero-supply mint and drain the",
            "vaults while real LP holders still had claims."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "bookMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "lpYieldAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpYieldBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  121,
                  105,
                  101,
                  108,
                  100,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "treasuryAmmVault",
          "docs": [
            "Treasury account for the AMM's token — owner pinned by config, the",
            "same binding `distribute_fees` uses. The cranker chooses nothing."
          ],
          "writable": true
        },
        {
          "name": "treasuryBookVault",
          "docs": [
            "Treasury account for the book's token. Two accounts because one SPL",
            "account holds one mint, and the venues are denominated differently."
          ],
          "writable": true
        },
        {
          "name": "cranker",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "sweepResidual",
      "discriminator": [
        230,
        118,
        35,
        155,
        165,
        110,
        141,
        19
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "venueMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "vaultAmm",
          "writable": true
        },
        {
          "name": "lpPosition",
          "docs": [
            "The creator's subsidy ledger. Read-only here: the sweep must LEAVE the",
            "unreclaimed portion of the subsidy in the vault, because a",
            "permissionless instruction that takes the full balance can be fired",
            "before the creator runs `reclaim_subsidy` — confiscating their posted",
            "capital to the treasury. The gate above protects winners; this",
            "reservation protects the creator. Both are claimants; neither may be",
            "raced.",
            "",
            "Unchecked rather than `Account<LpPosition>` so that a market which was",
            "never seeded can still be swept. `seed_lp` is a SEPARATE instruction",
            "from `create_market`, so a market can be created, traded and settled",
            "with no `LpPosition` ever existing — and an `Account<…>` here would",
            "fail to deserialize, leaving that market's surplus unsweepable and",
            "`close_market` (which requires an empty vault) blocked forever.",
            "",
            "Absence is PROVEN, not assumed: the seeds pin the address, and only",
            "the real PDA can be system-owned and empty. So a cranker cannot skip",
            "the creator's reserve by omitting the account — there is nothing to",
            "omit, and substituting a different account fails the seeds.",
            "",
            "handler before it is deserialized."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.creator",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "protocolTreasuryVault",
          "docs": [
            "The treasury's account for the AMM's token — owner pinned by config,",
            "exactly as in `distribute_fees`. The cranker chooses nothing."
          ],
          "writable": true
        },
        {
          "name": "cranker",
          "docs": [
            "Permissionless, like fee distribution: the residual must not be",
            "hostage to any one keeper, and every destination above is fixed."
          ],
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "tradePositions",
      "discriminator": [
        14,
        33,
        158,
        91,
        88,
        26,
        89,
        136
      ],
      "accounts": [
        {
          "name": "market",
          "docs": [
            "`mut` for exactly one write: `book_enabled` is flipped here when",
            "graduation fires. Nothing else in this instruction touches `Market`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "ammState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "userAmmAta",
          "writable": true
        },
        {
          "name": "marketVault",
          "writable": true
        },
        {
          "name": "ammMint",
          "address": "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feePoolAmm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  109,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "lpMintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "userLpAta",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "deltaShares",
          "type": "i128"
        },
        {
          "name": "maxCostWad",
          "type": "u128"
        }
      ]
    },
    {
      "name": "transferAuthority",
      "docs": [
        "Nominate a new protocol authority. Nothing moves until the nominee",
        "signs `accept_authority`; passing the default pubkey withdraws a",
        "pending nomination."
      ],
      "discriminator": [
        48,
        169,
        76,
        72,
        229,
        180,
        55,
        161
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "updateProtocolConfig",
      "docs": [
        "Update the live `ProtocolConfig`. Authority-gated, sparse — `None`",
        "leaves a field alone. `authority`, `pending_authority` and `paused`",
        "are deliberately out of reach; see `update_protocol_config`."
      ],
      "discriminator": [
        197,
        97,
        123,
        54,
        221,
        168,
        11,
        135
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateProtocolConfigArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "adjudicatorEntry",
      "discriminator": [
        250,
        169,
        54,
        228,
        58,
        234,
        100,
        131
      ]
    },
    {
      "name": "ammState",
      "discriminator": [
        66,
        127,
        244,
        168,
        102,
        12,
        95,
        2
      ]
    },
    {
      "name": "lockEntry",
      "discriminator": [
        16,
        231,
        37,
        238,
        93,
        97,
        205,
        107
      ]
    },
    {
      "name": "lpPosition",
      "discriminator": [
        105,
        241,
        37,
        200,
        224,
        2,
        252,
        90
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "protocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "resolutionCommitment",
      "discriminator": [
        132,
        101,
        69,
        121,
        158,
        30,
        226,
        32
      ]
    }
  ],
  "events": [
    {
      "name": "adjudicatorEntryForceCreated",
      "discriminator": [
        255,
        150,
        163,
        123,
        80,
        219,
        24,
        213
      ]
    },
    {
      "name": "adjudicatorRegistered",
      "discriminator": [
        55,
        141,
        114,
        235,
        220,
        17,
        20,
        25
      ]
    },
    {
      "name": "authorityTransferAccepted",
      "discriminator": [
        149,
        165,
        140,
        221,
        104,
        203,
        239,
        121
      ]
    },
    {
      "name": "authorityTransferStarted",
      "discriminator": [
        226,
        104,
        201,
        223,
        128,
        33,
        164,
        193
      ]
    },
    {
      "name": "bookFilled",
      "discriminator": [
        134,
        27,
        55,
        180,
        174,
        105,
        208,
        243
      ]
    },
    {
      "name": "bookOrderCancelled",
      "discriminator": [
        30,
        121,
        53,
        249,
        40,
        18,
        202,
        9
      ]
    },
    {
      "name": "bookOrderPlaced",
      "discriminator": [
        249,
        106,
        60,
        191,
        67,
        209,
        179,
        21
      ]
    },
    {
      "name": "disputeRaised",
      "discriminator": [
        246,
        167,
        109,
        37,
        142,
        45,
        38,
        176
      ]
    },
    {
      "name": "invalidAttestationForced",
      "discriminator": [
        242,
        35,
        106,
        252,
        165,
        65,
        10,
        15
      ]
    },
    {
      "name": "lockClaimed",
      "discriminator": [
        226,
        164,
        109,
        42,
        115,
        151,
        115,
        59
      ]
    },
    {
      "name": "lpRedeemed",
      "discriminator": [
        232,
        192,
        98,
        44,
        177,
        24,
        2,
        106
      ]
    },
    {
      "name": "lpSeeded",
      "discriminator": [
        34,
        83,
        34,
        229,
        136,
        105,
        240,
        100
      ]
    },
    {
      "name": "lpYieldSwept",
      "discriminator": [
        204,
        18,
        153,
        211,
        118,
        60,
        155,
        30
      ]
    },
    {
      "name": "marketClosed",
      "discriminator": [
        86,
        91,
        119,
        43,
        94,
        0,
        217,
        113
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "marketDismissed",
      "discriminator": [
        38,
        151,
        70,
        216,
        174,
        16,
        118,
        150
      ]
    },
    {
      "name": "marketFeesDistributed",
      "discriminator": [
        13,
        149,
        50,
        153,
        90,
        37,
        95,
        187
      ]
    },
    {
      "name": "marketGraduated",
      "discriminator": [
        66,
        242,
        94,
        146,
        88,
        76,
        225,
        23
      ]
    },
    {
      "name": "marketLocked",
      "discriminator": [
        57,
        30,
        242,
        116,
        238,
        156,
        185,
        189
      ]
    },
    {
      "name": "marketSettled",
      "discriminator": [
        237,
        212,
        22,
        175,
        201,
        117,
        215,
        99
      ]
    },
    {
      "name": "outcomeAttested",
      "discriminator": [
        249,
        112,
        243,
        78,
        100,
        115,
        176,
        160
      ]
    },
    {
      "name": "positionSold",
      "discriminator": [
        117,
        122,
        235,
        232,
        80,
        15,
        94,
        179
      ]
    },
    {
      "name": "positionTraded",
      "discriminator": [
        47,
        104,
        4,
        110,
        61,
        85,
        215,
        178
      ]
    },
    {
      "name": "protocolConfigUpdated",
      "discriminator": [
        20,
        99,
        32,
        237,
        111,
        86,
        195,
        199
      ]
    },
    {
      "name": "protocolInitialized",
      "discriminator": [
        173,
        122,
        168,
        254,
        9,
        118,
        76,
        132
      ]
    },
    {
      "name": "protocolPausedEvent",
      "discriminator": [
        0,
        32,
        186,
        132,
        252,
        198,
        0,
        66
      ]
    },
    {
      "name": "redeemed",
      "discriminator": [
        14,
        29,
        183,
        71,
        31,
        165,
        107,
        38
      ]
    },
    {
      "name": "refundClaimed",
      "discriminator": [
        136,
        64,
        242,
        99,
        4,
        244,
        208,
        130
      ]
    },
    {
      "name": "residualSwept",
      "discriminator": [
        72,
        205,
        219,
        77,
        249,
        124,
        150,
        130
      ]
    },
    {
      "name": "resolutionCommitmentPublished",
      "discriminator": [
        26,
        142,
        226,
        194,
        33,
        141,
        91,
        244
      ]
    },
    {
      "name": "resolutionCommitmentRevoked",
      "discriminator": [
        211,
        178,
        119,
        87,
        177,
        38,
        175,
        75
      ]
    },
    {
      "name": "voidedBookRedeem",
      "discriminator": [
        157,
        97,
        33,
        64,
        87,
        172,
        216,
        157
      ]
    },
    {
      "name": "voidedRedeem",
      "discriminator": [
        248,
        251,
        79,
        23,
        171,
        76,
        129,
        216
      ]
    },
    {
      "name": "zkAdjudicatorRegistered",
      "discriminator": [
        31,
        90,
        12,
        133,
        188,
        40,
        175,
        44
      ]
    },
    {
      "name": "zkOutcomeAttested",
      "discriminator": [
        99,
        58,
        3,
        252,
        40,
        224,
        174,
        186
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "marketNotOpen",
      "msg": "Market is not in the Open lifecycle state"
    },
    {
      "code": 6001,
      "name": "marketNotSettled",
      "msg": "Market is not Settled"
    },
    {
      "code": 6002,
      "name": "invalidLifecycleTransition",
      "msg": "Lifecycle transition not permitted from current state"
    },
    {
      "code": 6003,
      "name": "invalidOutcome",
      "msg": "Invalid outcome (must be NO=0, YES=1, or INVALID=2)"
    },
    {
      "code": 6004,
      "name": "zeroAmount",
      "msg": "Amount must be non-zero"
    },
    {
      "code": 6005,
      "name": "insufficientOutcomeShares",
      "msg": "Insufficient outcome-token balance"
    },
    {
      "code": 6006,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6007,
      "name": "vaultAuthorityMismatch",
      "msg": "Vault / mint authority mismatch"
    },
    {
      "code": 6008,
      "name": "invalidDeadline",
      "msg": "Deadline must be greater than start_time"
    },
    {
      "code": 6009,
      "name": "adjudicatorIsDefault",
      "msg": "Adjudicator pubkey must not be the default (all-zero) key"
    },
    {
      "code": 6010,
      "name": "marketNotDismissed",
      "msg": "Market is not dismissed"
    },
    {
      "code": 6011,
      "name": "tradingClosed",
      "msg": "Trading window has closed (now >= deadline)"
    },
    {
      "code": 6012,
      "name": "invalidTick",
      "msg": "Invalid tick"
    },
    {
      "code": 6013,
      "name": "amountTooSmallForBaseTokenDecimals",
      "msg": "Amount too small for base token decimals"
    },
    {
      "code": 6014,
      "name": "slippageExceeded",
      "msg": "Slippage: cost exceeded max_cost_wad"
    },
    {
      "code": 6015,
      "name": "zeroDelta",
      "msg": "delta_shares must be non-zero"
    },
    {
      "code": 6016,
      "name": "insufficientShares",
      "msg": "Insufficient shares to sell"
    },
    {
      "code": 6017,
      "name": "marketDismissed",
      "msg": "Market is dismissed"
    },
    {
      "code": 6018,
      "name": "invalidLiquidity",
      "msg": "Liquidity parameter b must be > 0"
    },
    {
      "code": 6019,
      "name": "unauthorized",
      "msg": "Caller is not authorized for this action (creator mismatch)"
    },
    {
      "code": 6020,
      "name": "tradingNotStarted",
      "msg": "Trading window has not started yet (now < start_time)"
    },
    {
      "code": 6021,
      "name": "sellNotImplemented",
      "msg": "Sell path is not implemented yet — see trade_positions.rs §6 / architecture §4.3"
    },
    {
      "code": 6022,
      "name": "lockNotElapsed",
      "msg": "Lock has not elapsed yet (now < lock_entry.unlock_at)"
    },
    {
      "code": 6023,
      "name": "lockVaultMismatch",
      "msg": "Lock vault account does not match market.lock_vault"
    },
    {
      "code": 6024,
      "name": "trialNotExpired",
      "msg": "Trial period has not expired yet"
    },
    {
      "code": 6025,
      "name": "alreadyGraduated",
      "msg": "Market has already graduated"
    },
    {
      "code": 6026,
      "name": "alreadyDismissed",
      "msg": "Market has already been dismissed"
    },
    {
      "code": 6027,
      "name": "ammStateMarketMismatch",
      "msg": "AmmState market backlink does not match market account"
    },
    {
      "code": 6028,
      "name": "feeBpsOutOfRange",
      "msg": "Fee bps must not exceed 10000 (100%)"
    },
    {
      "code": 6029,
      "name": "feeSplitMismatch",
      "msg": "Fee split bps do not sum to 10000"
    },
    {
      "code": 6030,
      "name": "invalidTreasury",
      "msg": "Treasury pubkey must be non-default"
    },
    {
      "code": 6031,
      "name": "invalidTrialPeriod",
      "msg": "Default trial period must be > 0"
    },
    {
      "code": 6032,
      "name": "nothingToDistribute",
      "msg": "Fee pool is empty — nothing to distribute"
    },
    {
      "code": 6033,
      "name": "notGraduated",
      "msg": "Market is not graduated"
    },
    {
      "code": 6034,
      "name": "zeroLpAmount",
      "msg": "LP amount must be > 0"
    },
    {
      "code": 6035,
      "name": "emptyLpSupply",
      "msg": "LP supply is empty"
    },
    {
      "code": 6036,
      "name": "legacyDrainAlreadyExecuted",
      "msg": "Legacy fee drain already executed"
    },
    {
      "code": 6037,
      "name": "notAuthority",
      "msg": "Caller is not the registered authority for this adjudicator"
    },
    {
      "code": 6038,
      "name": "alreadyAttested",
      "msg": "Adjudicator has already attested an outcome; re-attestation is not permitted"
    },
    {
      "code": 6039,
      "name": "adjudicatorMarketMismatch",
      "msg": "Adjudicator account does not match the supplied market"
    },
    {
      "code": 6040,
      "name": "alreadyDisputed",
      "msg": "Adjudicator has already been disputed; dispute is one-shot per market"
    },
    {
      "code": 6041,
      "name": "marketAlreadySettled",
      "msg": "Market is already settled; dispute can no longer override the outcome"
    },
    {
      "code": 6042,
      "name": "invalidOrderId",
      "msg": "Order id is outside the supported composite encoding range"
    },
    {
      "code": 6043,
      "name": "orderIdSeedMismatch",
      "msg": "Decoded order id does not match the requested side or tick"
    },
    {
      "code": 6044,
      "name": "bookSideFull",
      "msg": "Book side is full for this tick"
    },
    {
      "code": 6045,
      "name": "bookSideNotDrained",
      "msg": "Book side is not fully drained"
    },
    {
      "code": 6046,
      "name": "compactBoundExceeded",
      "msg": "Compaction drop count exceeds the per-call bound"
    },
    {
      "code": 6047,
      "name": "wrongBaseMint",
      "msg": "Market vault uses the wrong base mint"
    },
    {
      "code": 6048,
      "name": "baseMintDrift",
      "msg": "MarketBook base mint does not match the market vault mint"
    },
    {
      "code": 6049,
      "name": "accumulatorNotReset",
      "msg": "MarketBook accumulators must be reset before placing an order"
    },
    {
      "code": 6050,
      "name": "noCancellableOrder",
      "msg": "No cancellable order was found"
    },
    {
      "code": 6051,
      "name": "missingCrossingBookSide",
      "msg": "Remaining-account bundle does not carry the crossing BookSide"
    },
    {
      "code": 6052,
      "name": "makerAccountMismatch",
      "msg": "Remaining-account bundle maker does not match the live order maker"
    },
    {
      "code": 6053,
      "name": "wrongBundleArity",
      "msg": "Remaining-account bundles must contain exactly three accounts per fill"
    },
    {
      "code": 6054,
      "name": "protocolPaused",
      "msg": "Protocol is paused; trading, new liquidity and market creation are disabled"
    },
    {
      "code": 6055,
      "name": "notYetAttested",
      "msg": "Adjudicator has not yet attested an outcome for this market"
    },
    {
      "code": 6056,
      "name": "tradingNotClosed",
      "msg": "Trading window has not closed yet (now < deadline)"
    },
    {
      "code": 6057,
      "name": "eventTooLarge",
      "msg": "Serialized event payload exceeds the 10 KiB instruction-data limit"
    },
    {
      "code": 6058,
      "name": "vetoWindowOpen",
      "msg": "Veto window is still open; settle is not callable until it closes"
    },
    {
      "code": 6059,
      "name": "vetoWindowClosed",
      "msg": "Veto window has closed; the attested outcome can no longer be disputed"
    },
    {
      "code": 6060,
      "name": "invalidVetoPeriod",
      "msg": "veto_period_secs must be > 0 and <= MAX_VETO_PERIOD_SECS"
    },
    {
      "code": 6061,
      "name": "insufficientSeedDeposit",
      "msg": "seed_deposit_wad must cover the LMSR worst-case subsidy b*ln(2)"
    },
    {
      "code": 6062,
      "name": "invalidBookAccount",
      "msg": "Book account is malformed, mis-sized or has the wrong discriminator"
    },
    {
      "code": 6063,
      "name": "matchFailed",
      "msg": "Order placement or matching failed"
    },
    {
      "code": 6064,
      "name": "bookCapacityTooLarge",
      "msg": "Requested book capacity exceeds the per-instruction realloc limit"
    },
    {
      "code": 6065,
      "name": "invalidQuestion",
      "msg": "Question is empty or exceeds the maximum length"
    },
    {
      "code": 6066,
      "name": "questionHashMismatch",
      "msg": "question_hash is not the hash of the supplied question"
    },
    {
      "code": 6067,
      "name": "marketNotClosable",
      "msg": "Market is not in a closeable state"
    },
    {
      "code": 6068,
      "name": "vaultNotEmpty",
      "msg": "A vault still holds funds — every claim must be paid before close"
    },
    {
      "code": 6069,
      "name": "feePoolNotEmpty",
      "msg": "A fee pool still holds funds — distribute before close"
    },
    {
      "code": 6070,
      "name": "bookNotEmpty",
      "msg": "The book still has live orders or funded seats"
    },
    {
      "code": 6071,
      "name": "outstandingClaims",
      "msg": "Winning shares are still unredeemed — the balance is owed, not residual"
    },
    {
      "code": 6072,
      "name": "zkNotEnabled",
      "msg": "Adjudicator entry is not zk-enabled; use the manual attest path"
    },
    {
      "code": 6073,
      "name": "zkAttestationFieldTooLong",
      "msg": "An attestation field exceeds its maximum encoded length"
    },
    {
      "code": 6074,
      "name": "zkInvalidSignatureV",
      "msg": "Signature v byte must be 27 or 28"
    },
    {
      "code": 6075,
      "name": "zkMalleableSignature",
      "msg": "Signature s value is above secp256k1n/2 and therefore malleable"
    },
    {
      "code": 6076,
      "name": "zkSignatureRecoveryFailed",
      "msg": "secp256k1 public-key recovery failed for this attestation"
    },
    {
      "code": 6077,
      "name": "zkAttestorMismatch",
      "msg": "Recovered attestor does not match the address registered for this market"
    },
    {
      "code": 6078,
      "name": "zkRuleHashMismatch",
      "msg": "Attestation url and parsePath do not match the registered rule_hash"
    },
    {
      "code": 6079,
      "name": "zkResponseResolveCountInvalid",
      "msg": "A zk attestation must carry exactly one responseResolve entry"
    },
    {
      "code": 6080,
      "name": "zkDataUnparseable",
      "msg": "Attested data is not a bare decimal or a single-key object holding one"
    },
    {
      "code": 6081,
      "name": "zkValuePrecisionTooHigh",
      "msg": "Attested value carries more fractional digits than the registered scale"
    },
    {
      "code": 6082,
      "name": "zkValueOutOfRange",
      "msg": "Attested value does not fit the fixed-point range"
    },
    {
      "code": 6083,
      "name": "zkInvalidComparator",
      "msg": "Comparator discriminant is not a known ZkComparator"
    },
    {
      "code": 6084,
      "name": "zkInvalidValueScale",
      "msg": "value_scale exceeds MAX_ZK_VALUE_SCALE"
    },
    {
      "code": 6085,
      "name": "zkAttestationTimestampInvalid",
      "msg": "Attestation timestamp is outside the accepted window"
    },
    {
      "code": 6086,
      "name": "positionAddressMismatch",
      "msg": "Position account is not the PDA for this (market, user) pair"
    },
    {
      "code": 6087,
      "name": "positionOwnerMismatch",
      "msg": "Position account is not owned by sooth_core"
    },
    {
      "code": 6088,
      "name": "positionMalformed",
      "msg": "Position account buffer is shorter than a serialized Position"
    },
    {
      "code": 6089,
      "name": "positionUserMismatch",
      "msg": "Position.user does not match the signer"
    },
    {
      "code": 6090,
      "name": "positionMarketMismatch",
      "msg": "Position.market does not match the supplied market"
    },
    {
      "code": 6091,
      "name": "marketNotSeeded",
      "msg": "Market has no LMSR seed: seed_lp must run before it can trade"
    },
    {
      "code": 6092,
      "name": "refundsOutstanding",
      "msg": "Dismissed market still owes refunds; the subsidy cannot be reclaimed"
    },
    {
      "code": 6093,
      "name": "pdaAlreadyInitialized",
      "msg": "Target PDA is already initialized and cannot be created again"
    },
    {
      "code": 6094,
      "name": "lpSupplyNotZero",
      "msg": "LP supply is nonzero: holders can still redeem this yield themselves"
    },
    {
      "code": 6095,
      "name": "noPendingAuthority",
      "msg": "No authority transfer is pending on this protocol config"
    },
    {
      "code": 6096,
      "name": "adjudicatorEntryOwnerMismatch",
      "msg": "Adjudicator entry account is not owned by sooth_core"
    },
    {
      "code": 6097,
      "name": "zkEarlyRequiresSatisfied",
      "msg": "Early zk attestation must prove the rule SATISFIED — an unmet reading proves nothing before the deadline"
    }
  ],
  "types": [
    {
      "name": "adjudicatorEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "`sooth_core::Market` account this adjudicator resolves."
            ],
            "type": "pubkey"
          },
          {
            "name": "authority",
            "docs": [
              "Authority gating `attest_outcome`.",
              "",
              "Both registration paths reject `Pubkey::default()` as an argument, so",
              "on an entry that a registration wrote this is always a real key. The",
              "default pubkey is a deliberate SENTINEL, written by exactly one place:",
              "`force_invalid_attestation` creating an entry for a market that never",
              "had an adjudicator at all. It means \"no adjudicator exists\", and",
              "`require_named_authority` turns it into a refusal at every site that",
              "checks a signature against this field — so the hatch's entry hands",
              "nobody the right to resolve the market it rescued."
            ],
            "type": "pubkey"
          },
          {
            "name": "disputeAuthority",
            "docs": [
              "Authority gating the `dispute` veto path. Defaults to `authority` at",
              "register time; can be rotated to a guardian multisig via a future ix.",
              "Carries the same default-pubkey sentinel as `authority`, and",
              "`require_named_dispute_authority` refuses it the same way."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestedOutcome",
            "docs": [
              "Recorded outcome iff the authority has called `attest_outcome` (or",
              "the `dispute` veto path has overridden it). 0=NO, 1=YES, 2=INVALID."
            ],
            "type": {
              "option": "u8"
            }
          },
          {
            "name": "attestedAt",
            "docs": [
              "Unix-seconds timestamp of the original attestation."
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "disputed",
            "docs": [
              "One-shot guard: once `dispute` mutates `attested_outcome` this is set",
              "true and subsequent disputes are rejected."
            ],
            "type": "bool"
          },
          {
            "name": "disputedAt",
            "docs": [
              "Unix-seconds timestamp of the dispute. `None` if not yet disputed."
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "bump",
            "docs": [
              "Bump for the `AdjudicatorEntry` PDA."
            ],
            "type": "u8"
          },
          {
            "name": "zkComparator",
            "docs": [
              "How the attested value is tested against `zk_threshold`, and — because",
              "`ZkComparator::None` is discriminant zero — whether this entry is",
              "zk-enabled at all. An entry from the manual `register_adjudicator`",
              "path has a zeroed reserved region and therefore reads as `None`,",
              "which is what keeps `attest_outcome_zk` off every existing market."
            ],
            "type": "u8"
          },
          {
            "name": "zkValueScale",
            "docs": [
              "Decimal places the attested value and `zk_threshold` share. An",
              "attested value carrying more fractional digits than this is rejected",
              "rather than truncated."
            ],
            "type": "u8"
          },
          {
            "name": "zkAttestorEvm",
            "docs": [
              "The single EVM address whose signature over a Primus attestation this",
              "market accepts."
            ],
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "zkRuleHash",
            "docs": [
              "Commitment to the attestation's request url and responseResolve",
              "parsePath. It is what stops an attestation for a different endpoint,",
              "or a different field of the same endpoint, from being substituted —",
              "the signature alone only proves the attestor saw *something*.",
              "Composition: `crate::zk::compute_rule_hash`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "zkThreshold",
            "docs": [
              "Threshold in `10^zk_value_scale` units."
            ],
            "type": "i64"
          },
          {
            "name": "forcedInvalid",
            "docs": [
              "Was this entry's outcome written by the abandonment escape hatch",
              "(`force_invalid_attestation`) rather than by an adjudicator?",
              "",
              "One byte carved from `_reserved`, so every entry already on chain",
              "reads `false` — which is exactly right, since none of them was forced.",
              "",
              "It is what lets `attest_outcome` distinguish \"already resolved\" from",
              "\"resolved by a timeout in the adjudicator's absence\": the real",
              "authority may attest OVER a forced outcome, restarting the veto",
              "window, so the escape hatch can never take a market away from an",
              "adjudicator who is merely late. Cleared by that overwrite, and one-way",
              "otherwise — an outcome the authority attested is never forced."
            ],
            "type": "bool"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged. ONE byte is left, so the next field larger",
              "than a bool needs a separate PDA rather than this region."
            ],
            "type": {
              "array": [
                "u8",
                1
              ]
            }
          }
        ]
      }
    },
    {
      "name": "adjudicatorEntryForceCreated",
      "docs": [
        "Emitted by `force_invalid_attestation` when the market had NO",
        "`AdjudicatorEntry` at all and the hatch created one to write into.",
        "",
        "Separate from `InvalidAttestationForced`, which still fires alongside it:",
        "the forced outcome means the same thing either way, and this says only",
        "that the market was orphaned rather than merely abandoned. The created",
        "entry's `authority` and `dispute_authority` are both the default pubkey —",
        "nobody gains a resolution right from it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "cranker",
            "docs": [
              "Whoever cranked it, and paid the entry's rent. Unprivileged by",
              "construction — the entry it created names no authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "adjudicatorRegistered",
      "docs": [
        "Emitted by `register_adjudicator` when a new per-market `AdjudicatorEntry`",
        "PDA is created. Mirrors EVM `AdjudicatorBase.MarketConfigured`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ammState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "Backlink to `Market` PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "qYes",
            "docs": [
              "LMSR q_yes — shares outstanding on the YES side."
            ],
            "type": "i128"
          },
          {
            "name": "qNo",
            "docs": [
              "LMSR q_no — shares outstanding on the NO side."
            ],
            "type": "i128"
          },
          {
            "name": "b",
            "docs": [
              "LMSR liquidity parameter `b` (positive i128, stored signed)."
            ],
            "type": "i128"
          },
          {
            "name": "seedQYes",
            "type": "i128"
          },
          {
            "name": "seedQNo",
            "type": "i128"
          },
          {
            "name": "feeBBaseWad",
            "docs": [
              "Accumulated fee WAD for graduation threshold tracking."
            ],
            "type": "u128"
          },
          {
            "name": "trialEndAt",
            "docs": [
              "Trial window end timestamp (architecture §9)."
            ],
            "type": "i64"
          },
          {
            "name": "isGraduated",
            "type": "bool"
          },
          {
            "name": "isDismissed",
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          },
          {
            "name": "refundObligationUsdc",
            "docs": [
              "Aggregate refund obligation: the sum of `Position.locked_cost_usdc`",
              "over every position of this market, in AMM-token base units.",
              "",
              "`claim_refund` pays one position at a time out of a shared vault, so",
              "without a total the program cannot tell whether the vault covers what",
              "it owes. It is maintained at exactly the four sites that move",
              "`locked_cost_usdc`: `trade_positions` (a buy adds its cost),",
              "`sell_positions` (proceeds retire it), `redeem_amm_position`",
              "(settlement clears it), and `claim_refund` (a refund extinguishes it).",
              "",
              "Trustworthy only when `tracks_refund_obligation` is set — see there."
            ],
            "type": "u64"
          },
          {
            "name": "tracksRefundObligation",
            "docs": [
              "Has this AMM counted `refund_obligation_usdc` since its first trade?",
              "",
              "Set once, by `create_market`. Every account created before the counter",
              "existed reads `false` here and `0` in the counter while real positions",
              "stand behind it, and zero is the OVER-paying direction: it would say",
              "\"nothing is owed\" to `reclaim_subsidy` and hand the creator collateral",
              "that still backs refunds. So the counter is read as an obligation",
              "total only when this flag is set; when it is clear the counter is",
              "treated as unknown, never as zero."
            ],
            "type": "bool"
          },
          {
            "name": "isSeeded",
            "docs": [
              "Has `seed_lp` posted the LMSR subsidy for this market?",
              "",
              "Set once, by `seed_lp`. `create_market` and `seed_lp` are separate",
              "instructions, so between them a market exists with an empty curve;",
              "the trading paths refuse it by this flag. Legacy accounts read `false`",
              "while being genuinely seeded, so the trading paths do not read it",
              "alone — see `is_seeded_with`."
            ],
            "type": "bool"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                54
              ]
            }
          }
        ]
      }
    },
    {
      "name": "authorityTransferAccepted",
      "docs": [
        "Emitted by `accept_authority`: the nominee signed and the seat has moved."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previousAuthority",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "authorityTransferStarted",
      "docs": [
        "Emitted by `transfer_authority`: a handover has been NOMINATED and nothing",
        "has moved yet. `pending_authority` is the default pubkey when the call",
        "withdrew a nomination instead of making one."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "The outgoing authority, which still holds the seat at this point."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingAuthority",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "bookFill",
      "docs": [
        "One fill inside a [`BookFilled`] batch."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "makerSeq",
            "type": "u64"
          },
          {
            "name": "priceTick",
            "docs": [
              "Execution price — the MAKER's tick, not the taker's limit. The",
              "difference is the taker's price improvement."
            ],
            "type": "u16"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bookFilled",
      "docs": [
        "All fills from one `book_place`, batched into a single event.",
        "",
        "Batched rather than emitted per fill because a 20-fill cross would otherwise",
        "produce 20 inner instructions, and per-event overhead would dominate the",
        "marginal cost of a fill."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "takerSide",
            "type": "u8"
          },
          {
            "name": "fills",
            "type": {
              "vec": {
                "defined": {
                  "name": "bookFill"
                }
              }
            }
          },
          {
            "name": "fee",
            "docs": [
              "Total protocol fee paid by the taker, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "bookOrderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u64"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "refund",
            "docs": [
              "Escrow returned to the owner's seat credit."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "bookOrderPlaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "docs": [
              "Monotonic per-market sequence — the id `book_cancel` takes."
            ],
            "type": "u64"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "side",
            "docs": [
              "0 = bid (buy YES), 1 = ask (sell YES, i.e. buy NO at 1 - p)."
            ],
            "type": "u8"
          },
          {
            "name": "priceTick",
            "type": "u16"
          },
          {
            "name": "amount",
            "docs": [
              "Resting size in USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "createMarketArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "question",
            "docs": [
              "The question, in full.",
              "",
              "Only its hash is stored — `Market` keeps 32 bytes and the text is not",
              "persisted anywhere on chain. But it IS emitted in `MarketCreated`, so a",
              "client can recover it from the creation transaction without an indexer;",
              "the event is the only retrievable copy of the words a market asked.",
              "",
              "Verified against `question_hash` below, which is what makes the event",
              "trustworthy: without the check, a creator could store the hash of one",
              "question and broadcast the text of another, and nothing downstream",
              "could tell."
            ],
            "type": "string"
          },
          {
            "name": "questionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "startTime",
            "type": "i64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "adjudicator",
            "docs": [
              "Adjudicator pubkey recorded on Market. An `AdjudicatorEntry` PDA must",
              "be created separately via `register_adjudicator`."
            ],
            "type": "pubkey"
          },
          {
            "name": "initialB",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "disputeRaised",
      "docs": [
        "Emitted by `dispute` when the `dispute_authority` overrides an attested",
        "outcome. Mirrors EVM `AdjudicatorBase.MarketDisputed`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "disputer",
            "type": "pubkey"
          },
          {
            "name": "previousOutcome",
            "type": "u8"
          },
          {
            "name": "newOutcome",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "initializeProtocolArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ammFeeBps",
            "type": "u16"
          },
          {
            "name": "bookFeeBps",
            "type": "u16"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "bBaseShareBps",
            "type": "u16"
          },
          {
            "name": "lpYieldShareBps",
            "type": "u16"
          },
          {
            "name": "adjudicatorShareBps",
            "type": "u16"
          },
          {
            "name": "protocolShareBps",
            "type": "u16"
          },
          {
            "name": "defaultTrialPeriod",
            "type": "i64"
          },
          {
            "name": "permissionlessAdjudicators",
            "type": "bool"
          },
          {
            "name": "vetoPeriodSecs",
            "docs": [
              "Guardian-veto window in seconds. Use `DEFAULT_VETO_PERIOD_SECS` (24h)",
              "for real deployments; localnet fixtures pass a few seconds so the",
              "resolve → settle → redeem flow is exercisable in one test run."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "invalidAttestationForced",
      "docs": [
        "Emitted by `force_invalid_attestation`: a market whose adjudicator never",
        "attested has had `INVALID` written onto it by a stranger, so that it can",
        "settle at all. The ordinary veto window runs from `ts`, and the outcome is",
        "still overridable inside it — by the authority attesting over it, or by the",
        "dispute authority correcting it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "cranker",
            "docs": [
              "Whoever cranked it. Unprivileged by construction."
            ],
            "type": "pubkey"
          },
          {
            "name": "deadline",
            "docs": [
              "The deadline the timeout was measured from, so the log carries the",
              "whole justification without a second account read."
            ],
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "lockClaimed",
      "docs": [
        "Emitted by `claim_unlocked` after a successful payout. Mirrors the EVM",
        "`LocksProcessed`/`LockEntryRemoved` event family",
        "(`AMMEngine.sol:392-407`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "lockEntry",
            "type": "pubkey"
          },
          {
            "name": "amountUsdc",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "lockEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "amountUsdc",
            "docs": [
              "USDC amount locked (net proceeds after sell fee)."
            ],
            "type": "u64"
          },
          {
            "name": "unlockAt",
            "docs": [
              "Unix timestamp when the lock matures and `claim_unlocked` may proceed."
            ],
            "type": "i64"
          },
          {
            "name": "nonce",
            "docs": [
              "Nonce copied from `Position.lock_nonce` at sell time. Used to derive",
              "the PDA seed so each sell creates a unique LockEntry."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "lpPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "lpMint",
            "type": "pubkey"
          },
          {
            "name": "seedDepositWad",
            "docs": [
              "Creator's seed deposit in WAD (bookkeeping for dismiss/refund flow)."
            ],
            "type": "u128"
          },
          {
            "name": "graduatedAt",
            "docs": [
              "Unix seconds at which the market graduated. 0 = not graduated."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reclaimedBase",
            "docs": [
              "Subsidy already reclaimed after settlement, in USDC base units.",
              "",
              "A running total, because `reclaim_subsidy` is callable more than once:",
              "obligations shrink as traders redeem, so the free residual grows over",
              "time and a creator should not have to guess when to make a single call."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "lpRedeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "lpBurned",
            "type": "u64"
          },
          {
            "name": "usdcPaid",
            "docs": [
              "AMM-venue yield paid, in the AMM token."
            ],
            "type": "u64"
          },
          {
            "name": "bookPaid",
            "docs": [
              "Book-venue yield paid, in the book's token (USDC)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "lpSeeded",
      "docs": [
        "Emitted by `seed_lp` after the per-market `LpMint` + creator",
        "`LpPosition` PDA + creator's LP ATA are bootstrapped and seeded",
        "with the initial `lp_amount` allocation."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "lpMint",
            "type": "pubkey"
          },
          {
            "name": "creatorLpAta",
            "type": "pubkey"
          },
          {
            "name": "lpAmount",
            "type": "u64"
          },
          {
            "name": "seedDepositWad",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "lpYieldSwept",
      "docs": [
        "Emitted by `sweep_lp_yield`. The LP supply that would have claimed this",
        "yield no longer exists, so the remainder went to the treasury and the",
        "market can reach the all-zero balances `close_market` requires."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "ammAmount",
            "docs": [
              "AMM-token remainder moved out of `lp_yield_amm`."
            ],
            "type": "u64"
          },
          {
            "name": "bookAmount",
            "docs": [
              "Book-token remainder moved out of `lp_yield_book`."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "docs": [
              "Caller-supplied 16-byte id; the seed of this account's PDA and of",
              "every account derived from it. The SDK defaults it to the first 16",
              "bytes of `sha256(question)`, which makes one question resolve to one",
              "market and lets any client derive the PDA from the text alone."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "adjudicator",
            "docs": [
              "The adjudicator pubkey recorded at `initialize_market` time. The",
              "adjudicator is also registered as an `AdjudicatorEntry` PDA. This",
              "field remains the canonical source of truth for the market's",
              "designated adjudicator identity."
            ],
            "type": "pubkey"
          },
          {
            "name": "questionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "vaultBook",
            "docs": [
              "Book-venue collateral vault (`BOOK_TOKEN_MINT`).",
              "",
              "Named per venue: picking the wrong vault is the one mistake here that",
              "fails silently rather than loudly. An SPL token account holds exactly",
              "one mint, so the two vaults cannot be merged."
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultAmm",
            "docs": [
              "AMM-venue collateral vault (`AMM_TOKEN_MINT`)."
            ],
            "type": "pubkey"
          },
          {
            "name": "lockVault",
            "docs": [
              "AMM lock-on-sell escrow vault (`AMM_TOKEN_MINT`) — the sell path's",
              "cooldown holds proceeds here, so it follows the AMM's token."
            ],
            "type": "pubkey"
          },
          {
            "name": "startTime",
            "type": "i64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "lifecycle",
            "type": {
              "defined": {
                "name": "marketLifecycle"
              }
            }
          },
          {
            "name": "winningOutcome",
            "docs": [
              "Set by `settle`. 0=NO, 1=YES, 2=INVALID (only meaningful when",
              "lifecycle == Settled)."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bumps stored at `initialize_market` time."
            ],
            "type": "u8"
          },
          {
            "name": "vaultAuthorityBump",
            "type": "u8"
          },
          {
            "name": "lockAuthorityBump",
            "type": "u8"
          },
          {
            "name": "bookEnabled",
            "docs": [
              "Is the orderbook open for this market?",
              "",
              "Mirrors `AmmState.is_graduated`, set once when graduation fires in",
              "`trade_positions`. It lives here rather than being read from",
              "`AmmState` because `book_place` already loads `Market` and does NOT",
              "load `AmmState` — checking the real flag would mean adding an account",
              "and 32 bytes to every order, permanently, to read one bit, and a fill",
              "must cost zero extra accounts.",
              "",
              "The cost of mirroring is that two places hold the same fact. They",
              "cannot drift: graduation is one-way and set at exactly one site."
            ],
            "type": "bool"
          },
          {
            "name": "isDismissed",
            "docs": [
              "Has this market been dismissed?",
              "",
              "Mirrors `AmmState.is_dismissed`, written by `dismiss_market` alongside",
              "it. It lives here because dismissal and settlement are the two terminal",
              "outcomes of one market and must exclude each other: `settle` loads",
              "`Market` and does NOT load `AmmState`, so without the mirror the",
              "exclusion would cost an account and 32 bytes on the settle path — and",
              "the check that is not cheap is the check that gets skipped.",
              "",
              "The two flags cannot drift: dismissal is one-way and set at exactly one",
              "site, `dismiss_market`, which writes both."
            ],
            "type": "bool"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                96
              ]
            }
          }
        ]
      }
    },
    {
      "name": "marketClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "marketRentReclaimed",
            "type": "u64"
          },
          {
            "name": "bookRentReclaimed",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "docs": [
        "Mirror of EVM `LaunchpadEngine.MarketCreated`. Emitted by `create_market`",
        "after the four instruction legs land (architecture §4.1)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "question",
            "docs": [
              "The question in full — the ONLY place it exists on chain.",
              "",
              "`Market` stores just `question_hash`, so without this a client has no",
              "way to render what a market asked short of running an indexer that",
              "captured it off-chain at creation time. `create_market` proves this",
              "text hashes to the stored hash before emitting."
            ],
            "type": "string"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "adjudicator",
            "type": "pubkey"
          },
          {
            "name": "vaultBook",
            "type": "pubkey"
          },
          {
            "name": "vaultAmm",
            "type": "pubkey"
          },
          {
            "name": "initialB",
            "docs": [
              "Initial LMSR liquidity `b` in WAD. Stored on `AmmState` after ix4."
            ],
            "type": "u128"
          },
          {
            "name": "startTime",
            "type": "i64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketDismissed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "dismissedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketFeesDistributed",
      "docs": [
        "Per-market fee distribution event emitted by `distribute_fees(market)`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "totalUsdc",
            "type": "u64"
          },
          {
            "name": "toBBase",
            "type": "u64"
          },
          {
            "name": "toLpYield",
            "type": "u64"
          },
          {
            "name": "toAdjudicator",
            "type": "u64"
          },
          {
            "name": "toProtocol",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketGraduated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "feesAccumulatedWad",
            "type": "u128"
          },
          {
            "name": "thresholdWad",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "marketLifecycle",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "initializing"
          },
          {
            "name": "open"
          },
          {
            "name": "locked"
          },
          {
            "name": "settled"
          }
        ]
      }
    },
    {
      "name": "marketLocked",
      "docs": [
        "Emitted on the LIVE → RESOLVING transition: trading halts pending the",
        "adjudicator outcome. Counterpart of EVM `TruthMarket.MarketResolved`.",
        "See `state/lifecycle.rs`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketSettled",
      "docs": [
        "Mirror of EVM `TruthMarket.MarketSettled` (`TruthMarket.sol:130`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "winningOutcome",
            "docs": [
              "0=NO, 1=YES, 2=INVALID per protocol-wide OUTCOME encoding."
            ],
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "outcomeAttested",
      "docs": [
        "Emitted by `attest_outcome` when the per-market authority signs the",
        "resolution. Mirrors EVM `AdjudicatorBase.OutcomeAttested`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "winningOutcome",
            "docs": [
              "0=NO, 1=YES, 2=INVALID per protocol-wide OUTCOME encoding."
            ],
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "yesShares",
            "type": "i128"
          },
          {
            "name": "noShares",
            "type": "i128"
          },
          {
            "name": "lockedCostUsdc",
            "docs": [
              "Cumulative USDC cost paid by this position (used for refund on dismiss)."
            ],
            "type": "u64"
          },
          {
            "name": "lockNonce",
            "docs": [
              "Per-position nonce used to derive unique `LockEntry` PDAs on each sell."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "positionSold",
      "docs": [
        "Emitted on the sell branch of `trade_positions` after the proceeds have",
        "been moved into the per-sell `LockEntry` PDA. Mirrors the EVM",
        "`ProceedsLocked` event (`AMMEngine.sol:1011-1013`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "docs": [
              "0 = NO, 1 = YES."
            ],
            "type": "u8"
          },
          {
            "name": "sharesSold",
            "docs": [
              "Absolute share count sold (positive). Matches `|delta_shares|`."
            ],
            "type": "u128"
          },
          {
            "name": "lockEntry",
            "docs": [
              "Lock account that escrows the USDC proceeds. The corresponding",
              "`claim_unlocked` ix takes this pubkey as input."
            ],
            "type": "pubkey"
          },
          {
            "name": "amountUsdc",
            "docs": [
              "USDC base units escrowed (matches `lock_entry.amount_usdc`)."
            ],
            "type": "u64"
          },
          {
            "name": "unlockAt",
            "docs": [
              "Unix timestamp at which `claim_unlocked` becomes callable."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "positionTraded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "docs": [
              "0 = NO, 1 = YES (matches protocol-wide OUTCOME encoding)."
            ],
            "type": "u8"
          },
          {
            "name": "deltaShares",
            "docs": [
              "Signed share delta in WAD. Positive = buy; negative = sell."
            ],
            "type": "i128"
          },
          {
            "name": "costWad",
            "docs": [
              "Signed cost in WAD. Positive = paid; negative = proceeds (sell)."
            ],
            "type": "i128"
          },
          {
            "name": "ts",
            "docs": [
              "Unix timestamp from `Clock`."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "protocolConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Authority that may call setters (pause/unpause, future update ixs)."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "docs": [
              "USDC ATA where the protocol's slice of every fee distribution lands."
            ],
            "type": "pubkey"
          },
          {
            "name": "ammFeeBps",
            "docs": [
              "Total per-trade fee in basis points (1 bp = 0.01 %).",
              "Taker fee on the AMM, in bps. The incubation venue.",
              "",
              "Separate from the book's rate because the two are different products at",
              "different stages — and, being denominated in different tokens, cannot",
              "share a rate at all."
            ],
            "type": "u16"
          },
          {
            "name": "bookFeeBps",
            "docs": [
              "Taker fee on the orderbook, in bps. The mature venue."
            ],
            "type": "u16"
          },
          {
            "name": "graduationBps",
            "docs": [
              "Graduation threshold as a fraction of the creator's deposit, in bps.",
              "",
              "The deposit is `b · ln(2)` — the LMSR's maximum loss, and therefore",
              "exactly what the creator posted — so this reads as \"earn back N% of",
              "capital at risk\", 100% at 10 000.",
              "",
              "Zero is read as 10 000, so a config account laid out without this field",
              "keeps the 100% behaviour rather than graduating every market instantly."
            ],
            "type": "u16"
          },
          {
            "name": "bBaseShareBps",
            "docs": [
              "4-way fee-destination split bps — must sum to 10_000."
            ],
            "type": "u16"
          },
          {
            "name": "lpYieldShareBps",
            "type": "u16"
          },
          {
            "name": "adjudicatorShareBps",
            "type": "u16"
          },
          {
            "name": "protocolShareBps",
            "type": "u16"
          },
          {
            "name": "defaultTrialPeriod",
            "docs": [
              "Default trial period in seconds. Architecture §9."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          },
          {
            "name": "paused",
            "docs": [
              "Circuit-breaker flag. When `true`, `require_not_paused` rejects with",
              "`SoothCoreError::ProtocolPaused`.",
              "",
              "Scope is a TRADING halt, not a total freeze — see `require_not_paused`."
            ],
            "type": "bool"
          },
          {
            "name": "permissionlessAdjudicators",
            "docs": [
              "When `true`, anyone can register an adjudicator for any market.",
              "When `false`, only `config.authority` may call `register_adjudicator`."
            ],
            "type": "bool"
          },
          {
            "name": "vetoPeriodSecs",
            "docs": [
              "Guardian-veto window in seconds. `dispute` is callable while",
              "`now < attested_at + veto_period_secs`; `settle` only after.",
              "",
              "Configurable rather than a constant so localnet can run a few seconds",
              "while devnet runs 24h — same binary in both places. A build flag would",
              "mean the artifact under test is not the artifact deployed.",
              "",
              "Zero is rejected at `initialize_protocol` — see the guard there for",
              "why (an omitted Anchor arg encodes as 0)."
            ],
            "type": "i64"
          },
          {
            "name": "pendingAuthority",
            "docs": [
              "Nominee for `authority`, or `Pubkey::default()` when no transfer is",
              "in flight. Written by `transfer_authority`, consumed by",
              "`accept_authority`.",
              "",
              "Authority transfer is two-step precisely because this program has",
              "already been bitten once by an unreachable admin path: a one-step",
              "`set_authority` to a mistyped or non-signing key hands the protocol to",
              "nobody, permanently, and there is no recovery instruction that a lost",
              "authority can call. Requiring the nominee to sign an `accept` proves",
              "the key exists and is controlled before it takes over.",
              "",
              "Carved from `_reserved`, so every `ProtocolConfig` already on chain",
              "reads it as the default pubkey — which is exactly \"no transfer",
              "pending\"."
            ],
            "type": "pubkey"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it. (Unlike EVM, where appending a storage slot is free.)",
              "Nothing in the program can realloc or close a `ProtocolConfig`, so a",
              "deployed singleton that is too short for the struct is unrecoverable.",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                28
              ]
            }
          }
        ]
      }
    },
    {
      "name": "protocolConfigUpdated",
      "docs": [
        "Emitted by `update_protocol_config`. Carries the WHOLE resulting config",
        "rather than the fields that moved: the instruction is sparse, so a log of",
        "only the deltas cannot be read without also knowing what was there before,",
        "and an audit trail that needs a second source is not one."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "ammFeeBps",
            "type": "u16"
          },
          {
            "name": "bookFeeBps",
            "type": "u16"
          },
          {
            "name": "graduationBps",
            "type": "u16"
          },
          {
            "name": "bBaseShareBps",
            "type": "u16"
          },
          {
            "name": "lpYieldShareBps",
            "type": "u16"
          },
          {
            "name": "adjudicatorShareBps",
            "type": "u16"
          },
          {
            "name": "protocolShareBps",
            "type": "u16"
          },
          {
            "name": "defaultTrialPeriod",
            "type": "i64"
          },
          {
            "name": "vetoPeriodSecs",
            "type": "i64"
          },
          {
            "name": "permissionlessAdjudicators",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "protocolInitialized",
      "docs": [
        "Emitted once per protocol deploy by `initialize_protocol`. Indexers can",
        "pin the cluster's authority + treasury without re-reading the PDA."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "ammFeeBps",
            "type": "u16"
          },
          {
            "name": "bookFeeBps",
            "type": "u16"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "protocolPausedEvent",
      "docs": [
        "Emitted by `pause` and `unpause`. `paused = true` means the protocol was",
        "just paused; `paused = false` means it was just unpaused."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "publishResolutionCommitmentArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merkleRoot",
            "docs": [
              "Root of the per-wallet entitlement tree."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tStar",
            "docs": [
              "The moment the market's event became public knowledge."
            ],
            "type": "i64"
          },
          {
            "name": "leafCount",
            "docs": [
              "Leaves in the tree. Published so the tree's shape is reproducible."
            ],
            "type": "u32"
          },
          {
            "name": "totalVoidRefundUsdc",
            "docs": [
              "Ceiling on the USDC the AMM void path may pay out across every leaf."
            ],
            "type": "u64"
          },
          {
            "name": "totalBookVoidRefundUsdc",
            "docs": [
              "The same ceiling for the BOOK venue, whose refunds leave a different",
              "vault. Zero on a market that never graduated — and a market with no",
              "book account may publish nothing else."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redeemed",
      "docs": [
        "Mirror of EVM `OrderEngine.PositionSettled` (`OrderEngine.sol:430`).",
        "Emitted by `redeem` after a successful post-settlement burn-and-pay."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "docs": [
              "Resolved outcome at the time of redeem, copied from",
              "`Market::winning_outcome`. 0=NO, 1=YES, 2=INVALID."
            ],
            "type": "u8"
          },
          {
            "name": "yesBurned",
            "docs": [
              "YES outcome-token base units burned (0 if user held none, or if",
              "outcome=NO)."
            ],
            "type": "u64"
          },
          {
            "name": "noBurned",
            "docs": [
              "NO outcome-token base units burned (0 if user held none, or if",
              "outcome=YES)."
            ],
            "type": "u64"
          },
          {
            "name": "usdcPaid",
            "docs": [
              "USDC base units transferred from vault to user."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "refundClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amountUsdc",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "registerZkAdjudicatorArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Gates `dispute`. Not an attestation authority: nothing about",
              "`attest_outcome_zk` is signer-gated."
            ],
            "type": "pubkey"
          },
          {
            "name": "attestorEvm",
            "docs": [
              "The one EVM address whose attestations this market accepts."
            ],
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "ruleHash",
            "docs": [
              "`crate::zk::compute_rule_hash(url, parse_path)`, computed off-chain by",
              "whoever picks the endpoint and re-derived on-chain from the submitted",
              "attestation."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "comparator",
            "docs": [
              "`ZkComparator` discriminant. `None` (0) is rejected — registering a",
              "zk entry that can never resolve is always a mistake."
            ],
            "type": "u8"
          },
          {
            "name": "threshold",
            "docs": [
              "Threshold in `10^value_scale` units."
            ],
            "type": "i64"
          },
          {
            "name": "valueScale",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "residualSwept",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "resolutionCommitment",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "`sooth_core::Market` this commitment resolves. Redundant with the",
              "seeds and checked anyway: the seeds bind the ADDRESS, this binds the",
              "CONTENT, and a leaf proof is only as good as the root it is checked",
              "against belonging to the market being redeemed."
            ],
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "docs": [
              "Root of the per-wallet entitlement tree. Leaves are composed by",
              "[`voided_leaf`]; the shape is in `crate::merkle`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tStar",
            "docs": [
              "The moment the market's event actually became public knowledge. Every",
              "trade at or before this is honest; everything after it is what the",
              "tree voids. Unix seconds, and always",
              "`market.start_time <= t_star <= min(attested_at, market.deadline)`."
            ],
            "type": "i64"
          },
          {
            "name": "leafCount",
            "docs": [
              "Number of leaves in the tree. Not consulted by proof verification —",
              "it is published so a third party can reproduce the tree's exact shape",
              "(the odd-node promotion rule depends on the leaf count at every level)",
              "and therefore its root."
            ],
            "type": "u32"
          },
          {
            "name": "totalVoidRefundUsdc",
            "docs": [
              "Total USDC the resolver claims the void path will pay out across all",
              "leaves. A ceiling, not an estimate: see `void_refund_paid_usdc`."
            ],
            "type": "u64"
          },
          {
            "name": "voidRefundPaidUsdc",
            "docs": [
              "Running total actually paid out by `redeem_amm_position`'s void path.",
              "Together with the field above this caps the cash the whole mechanism",
              "can move at a number published BEFORE the veto window closed — so an",
              "observer can compare the claim against the vault while there is still",
              "time to revoke it. Without the cap, a tree whose per-leaf bounds each",
              "pass could still drain the vault in aggregate."
            ],
            "type": "u64"
          },
          {
            "name": "publisher",
            "docs": [
              "Who published, and therefore who gets the rent back on revoke."
            ],
            "type": "pubkey"
          },
          {
            "name": "publishedAt",
            "docs": [
              "Unix seconds at publication. The veto deadline is derived from the",
              "ATTESTATION, not from this — publishing late must not extend the",
              "window in which the commitment can be scrutinised."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump for the `ResolutionCommitment` PDA."
            ],
            "type": "u8"
          },
          {
            "name": "totalBookVoidRefundUsdc",
            "docs": [
              "The same ceiling as `total_void_refund_usdc`, for the BOOK venue.",
              "",
              "Separate because the two venues are separate vaults holding separate",
              "mints: one ceiling over both would let an AMM refund consume the",
              "allowance a book refund was sized against, and no observer could tell",
              "which vault the published number was a claim about."
            ],
            "type": "u64"
          },
          {
            "name": "bookVoidRefundPaidUsdc",
            "docs": [
              "Running total paid out by `redeem_book_seat`'s void path."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "docs": [
              "Forward-compat padding. Adding a field consumes bytes from here",
              "instead of changing the account's length, so no migration is needed:",
              "Solana accounts are fixed-length buffers, and an `#[account]` struct",
              "that outgrows its buffer fails to deserialize on every instruction",
              "that loads it.",
              "",
              "When you add a field, shrink this by exactly its serialized size and",
              "leave `SPACE` unchanged."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          }
        ]
      }
    },
    {
      "name": "resolutionCommitmentPublished",
      "docs": [
        "Emitted by `publish_resolution_commitment`. Carries every field an",
        "observer needs to reproduce the commitment from the market's public event",
        "tape and compare roots inside the veto window — which is the mechanism's",
        "entire enforcement. See `docs/design/t-star-voiding.md`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "publisher",
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "docs": [
              "Root over one leaf per wallet."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tStar",
            "docs": [
              "The moment the market's event became public knowledge."
            ],
            "type": "i64"
          },
          {
            "name": "leafCount",
            "type": "u32"
          },
          {
            "name": "totalVoidRefundUsdc",
            "docs": [
              "Ceiling on the USDC the AMM void path may pay across every leaf."
            ],
            "type": "u64"
          },
          {
            "name": "totalBookVoidRefundUsdc",
            "docs": [
              "The same ceiling for the book venue."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "resolutionCommitmentRevoked",
      "docs": [
        "Emitted by `revoke_resolution_commitment`. The market redeems as if the",
        "commitment had never been published."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "disputeAuthority",
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "docs": [
              "The root being withdrawn, so the reason for the veto stays legible in",
              "the log after the account is gone."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "seedLpArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lpAmount",
            "type": "u64"
          },
          {
            "name": "seedDepositWad",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "updateProtocolConfigArgs",
      "docs": [
        "Sparse update. `None` leaves a field exactly as it is."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "permissionlessAdjudicators",
            "type": {
              "option": "bool"
            }
          },
          {
            "name": "treasury",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "ammFeeBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "bookFeeBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "graduationBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "bBaseShareBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "lpYieldShareBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "adjudicatorShareBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "protocolShareBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "defaultTrialPeriod",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "vetoPeriodSecs",
            "type": {
              "option": "i64"
            }
          }
        ]
      }
    },
    {
      "name": "voidedBookClaimArgs",
      "docs": [
        "A seat's entitlement under a published `ResolutionCommitment`, plus the",
        "proof that it is in the tree.",
        "",
        "The two values are the leaf preimage — they are not trusted, they are",
        "HASHED, and the hash must be provably in the published root. What the",
        "program additionally enforces is that even a leaf the resolver signed",
        "cannot settle a bigger net than the seat holds, nor refund more than the",
        "voided fills could possibly have cost."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "validNet",
            "docs": [
              "Signed net acquired at or before T* and still held: `> 0` long YES,",
              "`< 0` long NO."
            ],
            "type": "i64"
          },
          {
            "name": "bookVoidRefundUsdc",
            "docs": [
              "USDC paid for post-T* fills, returned at cost."
            ],
            "type": "u64"
          },
          {
            "name": "proof",
            "docs": [
              "Sibling hashes from the leaf up to the root."
            ],
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "voidedBookRedeem",
      "docs": [
        "Emitted by `redeem_book_seat` when the payout came from a published",
        "entitlement rather than from the raw seat. `Redeemed` still fires alongside",
        "it, so consumers that only track payouts need no change."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "validNet",
            "docs": [
              "Signed net acquired at or before T* — the part that settled."
            ],
            "type": "i64"
          },
          {
            "name": "bookVoidRefundUsdc",
            "docs": [
              "USDC returned at cost for post-T* fills."
            ],
            "type": "u64"
          },
          {
            "name": "heldNet",
            "docs": [
              "The seat's whole net. The difference against `valid_net` is what was",
              "voided."
            ],
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "voidedClaimArgs",
      "docs": [
        "A wallet's entitlement under a published `ResolutionCommitment`, plus the",
        "proof that it is in the tree.",
        "",
        "The three values are the leaf preimage — they are not trusted, they are",
        "HASHED, and the hash must be provably in the published root. What the",
        "program additionally enforces (in `voided_claim_payout`) is that even a",
        "leaf the resolver signed cannot pay more shares than the position holds or",
        "more cash than it paid in. So a dishonest resolver can under-pay, which the",
        "veto window catches, but cannot over-pay, which it could not."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "validYesWad",
            "docs": [
              "YES shares acquired at or before T* and still held, in WAD."
            ],
            "type": "u128"
          },
          {
            "name": "validNoWad",
            "docs": [
              "NO shares acquired at or before T* and still held, in WAD."
            ],
            "type": "u128"
          },
          {
            "name": "voidRefundUsdc",
            "docs": [
              "USDC paid for post-T* acquisitions, returned at cost."
            ],
            "type": "u64"
          },
          {
            "name": "proof",
            "docs": [
              "Sibling hashes from the leaf up to the root."
            ],
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "voidedRedeem",
      "docs": [
        "Emitted by `redeem_amm_position` when the payout came from a published",
        "entitlement rather than from the raw position. `Redeemed` still fires",
        "alongside it with the shares burned and the USDC paid, so consumers that",
        "only track payouts need no change."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "validYesWad",
            "docs": [
              "Shares acquired at or before T* and still held — the part that settled."
            ],
            "type": "u128"
          },
          {
            "name": "validNoWad",
            "type": "u128"
          },
          {
            "name": "voidRefundUsdc",
            "docs": [
              "USDC returned at cost for post-T* acquisitions."
            ],
            "type": "u64"
          },
          {
            "name": "heldYesWad",
            "docs": [
              "Shares the position held in total. The difference against the two",
              "valid legs is what was voided."
            ],
            "type": "u128"
          },
          {
            "name": "heldNoWad",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "zkAdjudicatorRegistered",
      "docs": [
        "Emitted by `register_zk_adjudicator`. Carries the full zk configuration so",
        "an indexer can reproduce the verification off-chain without re-reading the",
        "account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "attestorEvm",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "ruleHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "comparator",
            "type": "u8"
          },
          {
            "name": "threshold",
            "type": "i64"
          },
          {
            "name": "valueScale",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "zkAttestation",
      "docs": [
        "A Primus `Attestation`, carried as structured fields.",
        "",
        "`attestor_addr` and `attestor_url` mirror the Solidity `Attestor[]` entry,",
        "but note that array is OUTSIDE the signed digest. `attestor_addr` is",
        "therefore treated as an assertion the handler checks against the recovered",
        "signer, never as a trust input; `attestor_url` is carried for fidelity and",
        "is not interpreted at all."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "recipient",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "request",
            "type": {
              "defined": {
                "name": "zkNetworkRequest"
              }
            }
          },
          {
            "name": "responseResolve",
            "type": {
              "vec": {
                "defined": {
                  "name": "zkResponseResolve"
                }
              }
            }
          },
          {
            "name": "data",
            "type": "string"
          },
          {
            "name": "attConditions",
            "type": "string"
          },
          {
            "name": "timestamp",
            "docs": [
              "Solidity `uint64`, encoded big-endian by `abi.encodePacked`."
            ],
            "type": "u64"
          },
          {
            "name": "additionParams",
            "type": "string"
          },
          {
            "name": "attestorAddr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "attestorUrl",
            "type": "string"
          },
          {
            "name": "signature",
            "docs": [
              "`r ‖ s ‖ v`, with EVM's `v ∈ {27, 28}`."
            ],
            "type": {
              "array": [
                "u8",
                65
              ]
            }
          }
        ]
      }
    },
    {
      "name": "zkNetworkRequest",
      "docs": [
        "`AttNetworkRequest` from `IPrimusZKTLS.sol`. Field order is load-bearing —",
        "it is the packed-encoding order."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "url",
            "type": "string"
          },
          {
            "name": "header",
            "type": "string"
          },
          {
            "name": "method",
            "type": "string"
          },
          {
            "name": "body",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "zkOutcomeAttested",
      "docs": [
        "Emitted by `attest_outcome_zk` alongside `OutcomeAttested`.",
        "",
        "`OutcomeAttested` is still emitted, so consumers that only track outcomes",
        "need no change; this carries the evidence — the recovered signer and the",
        "value that was compared — for anyone auditing why the outcome is what it",
        "is during the veto window."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "adjudicatorEntry",
            "type": "pubkey"
          },
          {
            "name": "attestorEvm",
            "docs": [
              "The EVM address recovered from the signature, not the one supplied."
            ],
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "value",
            "docs": [
              "Attested value in `10^value_scale` units."
            ],
            "type": "i128"
          },
          {
            "name": "threshold",
            "type": "i64"
          },
          {
            "name": "comparator",
            "type": "u8"
          },
          {
            "name": "winningOutcome",
            "docs": [
              "0=NO, 1=YES."
            ],
            "type": "u8"
          },
          {
            "name": "attestationTs",
            "docs": [
              "The attestation's own timestamp, normalized to unix seconds."
            ],
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "zkResponseResolve",
      "docs": [
        "`AttNetworkResponseResolve` from `IPrimusZKTLS.sol`. Field order is the",
        "packed-encoding order."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "keyName",
            "type": "string"
          },
          {
            "name": "parseType",
            "type": "string"
          },
          {
            "name": "parsePath",
            "type": "string"
          }
        ]
      }
    }
  ]
};
