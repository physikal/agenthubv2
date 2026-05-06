import React, { useRef, useState } from "react";
import { streamTlsReconfigure } from "../../lib/api.js";

type Step =
  | "strategy"
  | "email"
  | "dns-provider"
  | "dns-token"
  | "self-ca-ip"
  | "confirm"
  | "running"
  | "done";

type Mode = "public-alpn" | "dns-01" | "self-ca";

interface State {
  mode: Mode | null;
  tlsEmail: string;
  dnsProvider: string;
  cfApiToken: string;
  lanIp: string;
}

export const ReconfigureTlsModal: React.FC<{
  initialDomain: string;
  defaultLanIp: string;
  onClose: () => void;
}> = ({ initialDomain, defaultLanIp, onClose }) => {
  const [step, setStep] = useState<Step>("strategy");
  const [state, setState] = useState<State>({
    mode: null,
    tlsEmail: "",
    dnsProvider: "cloudflare",
    cfApiToken: "",
    lanIp: defaultLanIp,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const pickStrategy = (mode: Mode): void => {
    setState((s) => ({ ...s, mode }));
    if (mode === "public-alpn" || mode === "dns-01") setStep("email");
    else setStep("self-ca-ip");
  };

  async function startReconfigure(): Promise<void> {
    setStep("running");
    abortRef.current = new AbortController();
    try {
      const dnsEnvVars: Record<string, string> = {};
      if (state.mode === "dns-01" && state.dnsProvider === "cloudflare") {
        dnsEnvVars["CF_DNS_API_TOKEN"] = state.cfApiToken;
      }
      const stream = streamTlsReconfigure(
        {
          mode: state.mode!,
          tlsEmail: state.tlsEmail,
          ...(state.mode === "dns-01" ? { dnsProvider: state.dnsProvider } : {}),
          ...(state.mode === "dns-01" ? { dnsEnvVars } : {}),
          ...(state.mode === "self-ca" ? { lanIp: state.lanIp } : {}),
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
        <h2>Reconfigure TLS for {initialDomain}</h2>

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
            <button onClick={() => pickStrategy("self-ca")}>
              <strong>Self-signed CA</strong>
              <p>Private CA on this host. Each device imports the CA once.</p>
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
                <code>agenthub reconfigure-tls</code> from the host shell.
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

        {step === "self-ca-ip" && (
          <div className="form">
            <label>
              LAN IP(s) for cert SAN (comma-separated):
              <input
                type="text"
                value={state.lanIp}
                onChange={(e) =>
                  setState((s) => ({ ...s, lanIp: e.target.value }))
                }
              />
            </label>
            <button onClick={() => setStep("confirm")}>Next</button>
          </div>
        )}

        {step === "confirm" && (
          <div className="confirm">
            <p>Apply this TLS configuration?</p>
            <ul>
              <li>
                Strategy: <strong>{state.mode}</strong>
              </li>
              {state.mode !== "self-ca" && <li>Email: {state.tlsEmail}</li>}
              {state.mode === "dns-01" && (
                <li>Provider: {state.dnsProvider}</li>
              )}
              {state.mode === "self-ca" && <li>LAN IP: {state.lanIp}</li>}
            </ul>
            <p className="hint">
              Traefik will be recreated. If the new cert can't be issued
              within 90 seconds, the previous TLS config is restored
              automatically.
            </p>
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
                <p>Reload the page to pick up the new cert.</p>
              </>
            )}
            <button onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
};
