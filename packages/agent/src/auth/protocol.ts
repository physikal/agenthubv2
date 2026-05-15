export type AuthInbound =
  | { type: "auth.connect"; tool: string; loginCommand: string; urlPattern: string; timeoutSec: number; credentialPaths?: string[] }
  | { type: "auth.cancel"; tool: string }
  | { type: "auth.input"; tool: string; text: string }
  | { type: "auth.disconnect"; tool: string; logoutCommand?: string; credentialPaths: string[] }
  | { type: "auth.hydrate"; entries: Array<{ tool: string; path: string; contentsBase64: string }> }
  | { type: "auth.hydrateProbe"; tools: Array<{ tool: string; paths: string[] }> };

export type AuthOutbound =
  | { type: "auth.line"; tool: string; stream: "stdout" | "stderr"; line: string }
  | { type: "auth.captured"; tool: string; path: string; contentsBase64: string }
  | { type: "auth.done"; tool: string; ok: boolean; error?: string }
  | { type: "auth.disconnected"; tool: string; ok: boolean; error?: string }
  | { type: "auth.hydrateProbeResult"; missing: Array<{ tool: string; path: string }> };
