export function useLockedProceeds(_marketAddress?: `0x${string}`) {
  const claimUnlocked = async () => undefined;
  const refetch = async () => undefined;

  return {
    lockedProceeds: 0n,
    userLocked: 0n,
    totalLocked: 0n,
    claimUnlocked,
    isClaimPending: false,
    claimTxHash: undefined,
    isClaimConfirmed: false,
    isLoading: false,
    refetch,
  };
}
