export function isEastboardFixtureMode(): boolean {
  return (
    import.meta.env.VITE_EASTBOARD_FIXTURES === "true" ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("fixtures"))
  );
}
