import React, { useRef, useState } from "react";
import { streamAccessReconfigure } from "../../lib/api.js";

type Step =
  | "access-mode"
  | "strategy"
  | "email"
  | "dns-provider"
  | "dns-token"
  | "confirm"
  | "running"
  | "done";

type AccessMode = "lan" | "public";
type TlsMode = "public-alpn" | "dns-01";

interface State {
  accessMode: AccessMode | null;
  mode: TlsMode | null;
  tlsEmail: string;
  dnsProvider: string;
  cfApiToken: string;
}

export const ReconfigureAccessModal: React.FC<{
  initialDomain: string;
  onClose: () => void;
}> = ({ initialDomain, onClose }) => {
  const [step, setStep] = useState<Step>("access-mode");
  const [state, setState] = useState<State>({
    accessMode: null,
    mode: null,
    tlsEmail: "",
    dnsProvider: "cloudflare",
    cfApiToken: "",
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const pickAccessMode = (accessMode: AccessMode): void => {
    setState((s) => ({ ...s, accessMode }));
    if (accessMode === "lan") {
      setStep("confirm");
    } else {
      setStep("strategy");
    }
  };

  const pickStrategy = (mode: TlsMode): void => {
    setState((s) => ({ ...s, mode }));
    setStep("email");
  };

  async function startReconfigure(): Promise<void> {
    setStep("running");
    abortRef.current = new AbortController();
    try {
      const dnsEnvVars: Record<string, string> = {};
      if (state.mode === "dns-01" && state.dnsProvider === "cloudflare") {
        dnsEnvVars["CF_DNS_API_TOKEN"] = state.cfApiToken;
      }
      const resolvedMode = state.accessMode === "lan" ? "lan" : state.mode!;
      const stream = streamAccessReconfigure(
        {
          mode: resolvedMode,
          tlsEmail: state.tlsEmail,
          ...(state.mode === "dns-01" ? { dnsProvider: state.dnsProvider } : {}),
          ...(state.mode === "dns-01" ? { dnsEnvVars } : {}),
        },
        abortRef.current.signal,
      );
      for await (const ev of stream) {
        if (ev.event === "log") {
          setLogs((cur) => [...cur, ev.data]);
        } else if (ev.event === "error") {
          setError(ev.data);
          setStep("done");
          return;
        } else if (ev.event === "done") {
          setStep("done");
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
      setStep("done");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Reconfigure access for {initialDomain}</h2>

        {step === "access-mode" && (
          <div className="strategy-options">
            <button onClick={() => pickAccessMode("lan")}>
              <strong>LAN only</strong>
              <p>HTTP access from your local network. No TLS required.</p>
            </button>
            <button onClick={() => pickAccessMode("public")}>
              <strong>Public (HTTPS)</strong>
              <p>Publicly reachable with a trusted TLS certificate.</p>
            </button>
          </div>
        )}

        {step === "strategy" && (
          <div className="strategy-options">
            <button onClick={() => pickStrategy("public-alpn")}>
              <strong>Public ACME</strong>
              <p>Let's Encrypt cert via TLS-ALPN-01. Needs port 443 reachable from public internet.</p>
            </button>
            <button onClick={() => pickStrategy("dns-01")}>
              <strong>DNS challenge</strong>
              <p>Let's Encrypt cert via your DNS provider's API. Use this for internal-only hosts.</p>
            </button>
          </div>
        )}

        {step === "email" && (
          <div className="form">
            <label>
              Email for Let's Encrypt notifications:
              <input
                type="email"
                value={state.tlsEmail}
                onChange={(e) =>
                  setState((s) => ({ ...s, tlsEmail: e.target.value }))
                }
              />
            </label>
            <button
              disabled={!state.tlsEmail.includes("@")}
              onClick={() =>
                setStep(state.mode === "dns-01" ? "dns-provider" : "confirm")
              }
            >
              Next
            </button>
          </div>
        )}

        {step === "dns-provider" && (
          <div className="form">
            <label>
              DNS provider:
              <select
                value={state.dnsProvider}
                onChange={(e) =>
                  setState((s) => ({ ...s, dnsProvider: e.target.value }))
                }
              >
                <option value="cloudflare">Cloudflare</option>
                <option value="other">Other (CLI only)</option>
              </select>
            </label>
            {state.dnsProvider === "cloudflare" ? (
              <button onClick={() => setStep("dns-token")}>Next</button>
            ) : (
              <p className="hint">
                Other providers must be configured via{" "}
                <code>agenthub reconfigure-access</code> from the host shell.
                Run with the appropriate lego env vars exported.
                <button onClick={onClose}>Close</button>
              </p>
            )}
          </div>
        )}

        {step === "dns-token" && (
          <div className="form">
            <label>
              Cloudflare API token (DNS:Edit on the zone):
              <input
                type="password"
                value={state.cfApiToken}
                onChange={(e) =>
                  setState((s) => ({ ...s, cfApiToken: e.target.value }))
                }
              />
            </label>
            <button
              disabled={!state.cfApiToken}
              onClick={() => setStep("confirm")}
            >
              Next
            </button>
          </div>
        )}

        {step === "confirm" && (
          <div className="confirm">
            <p>Apply this access configuration?</p>
            <ul>
              <li>
                Access mode: <strong>{state.accessMode}</strong>
              </li>
              {state.accessMode === "public" && (
                <li>
                  TLS strategy: <strong>{state.mode}</strong>
                </li>
              )}
              {state.accessMode === "public" && <li>Email: {state.tlsEmail}</li>}
              {state.mode === "dns-01" && (
                <li>Provider: {state.dnsProvider}</li>
              )}
            </ul>
            {state.accessMode === "public" && (
              <p className="hint">
                Traefik will be recreated. If the new cert can't be issued
                within 90 seconds, the previous TLS config is restored
                automatically.
              </p>
            )}
            <button onClick={() => void startReconfigure()}>Apply</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        )}

        {step === "running" && (
          <div className="progress">
            <p>Applying…</p>
            <pre className="logs">
              {logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </pre>
            <button onClick={() => abortRef.current?.abort()}>Cancel</button>
          </div>
        )}

        {step === "done" && (
          <div className="result">
            {error ? (
              <>
                <h3 className="error">Reconfigure failed</h3>
                <p>{error}</p>
              </>
            ) : (
              <>
                <h3 className="success">Reconfigure complete</h3>
                <p>Reload the page to pick up the new configuration.</p>
              </>
            )}
            <button onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
};
