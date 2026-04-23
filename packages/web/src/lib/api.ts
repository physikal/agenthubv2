/** Fetch wrapper that includes credentials and handles 401 globally. */
export async function api(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  // `cache: "no-store"` is critical for polling endpoints like
  // /api/admin/version. Without it, the browser's HTTP heuristic cache
  // can serve a stale response for minutes even though the server has
  // moved on — the update modal's "Restarting server" detection
  // silently stalls because `info.current.sha` never updates.
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 401) {
    // Force reload to show login page
    window.location.reload();
    throw new Error("Unauthorized");
  }
  return res;
}
