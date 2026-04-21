/** Fetch wrapper that includes credentials and handles 401 globally. */
export async function api(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetch(path, { ...options, credentials: "include" });
  if (res.status === 401) {
    // Force reload to show login page
    window.location.reload();
    throw new Error("Unauthorized");
  }
  return res;
}
