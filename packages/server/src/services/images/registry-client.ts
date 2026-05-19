interface TagsResponse {
  readonly results: ReadonlyArray<{ readonly name: string }>;
  readonly next: string | null;
}

interface TokenResponse {
  readonly token: string;
}

export interface RegistryClient {
  listTags(repo: string, maxPages: number): Promise<readonly string[]>;
  getDigest(repo: string, tag: string): Promise<string>;
}

// Official Docker Hub images (single-segment names like "traefik", "postgres",
// "redis") live under the implicit "library/" namespace. The v2 APIs reject
// the unprefixed form with 404. Mirrors how `docker pull traefik` resolves
// to `library/traefik`. We do this in the client so the catalog can keep
// the user-facing short form, which is also what gets written to .env.
function namespaced(repo: string): string {
  return repo.includes("/") ? repo : `library/${repo}`;
}

export class DockerHubClient implements RegistryClient {
  async listTags(repo: string, maxPages: number): Promise<readonly string[]> {
    const out: string[] = [];
    let url: string | null =
      `https://hub.docker.com/v2/repositories/${encodeURI(namespaced(repo))}/tags?page_size=100`;
    let pages = 0;
    while (url && pages < maxPages) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`docker hub listTags(${repo}) failed: ${String(res.status)}`);
      }
      const body = (await res.json()) as TagsResponse;
      for (const r of body.results) out.push(r.name);
      url = body.next;
      pages += 1;
    }
    return out;
  }

  async getDigest(repo: string, tag: string): Promise<string> {
    const ns = namespaced(repo);
    const tokenUrl =
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${encodeURI(ns)}:pull`;
    const tokenRes = await fetch(tokenUrl);
    if (!tokenRes.ok) {
      throw new Error(`docker hub auth failed: ${String(tokenRes.status)}`);
    }
    const tokenBody = (await tokenRes.json()) as TokenResponse;
    const manifestUrl = `https://registry-1.docker.io/v2/${encodeURI(ns)}/manifests/${encodeURIComponent(tag)}`;
    const res = await fetch(manifestUrl, {
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        accept: "application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!res.ok) {
      throw new Error(`docker hub getDigest(${repo}:${tag}) failed: ${String(res.status)}`);
    }
    const digest = res.headers.get("Docker-Content-Digest");
    if (!digest) throw new Error(`docker hub getDigest(${repo}:${tag}) missing digest header`);
    return digest;
  }
}
