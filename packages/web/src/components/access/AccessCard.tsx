import React, { useEffect, useState } from "react";
import {
  getHealth,
  accessTest,
  type TlsHealthResponse,
} from "../../lib/api.js";
import { ReconfigureAccessModal } from "./ReconfigureAccessModal.js";

function statusIcon(tls: TlsHealthResponse): "ok" | "warn" | "error" {
  if (!tls.ok) return "error";
  if (tls.warnings.length > 0) return "warn";
  return "ok";
}

export const AccessCard: React.FC = () => {
  const [tls, setTls] = useState<TlsHealthResponse | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TlsHealthResponse | null>(null);

  async function refresh(): Promise<void> {
    const h = await getHealth();
    setTls(h.tls ?? null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (!tls) {
    return (
      <div className="card">
        <h3>Access</h3>
        <p className="muted">No access data (localhost install or probe pending).</p>
      </div>
    );
  }

  if (tls.resolver === "lan") {
    return (
      <div className="card">
        <h3>Access</h3>
        <p className="muted">
          LAN-only access via <code>http://{tls.domain}</code>. No TLS configured.
        </p>
        <div className="actions">
          <button onClick={() => setShowModal(true)}>Switch mode</button>
        </div>
        {showModal && (
          <ReconfigureAccessModal
            initialDomain={tls.domain}
              onClose={() => {
              setShowModal(false);
              void refresh();
            }}
          />
        )}
      </div>
    );
  }

  const icon = statusIcon(tls);

  async function runTest(): Promise<void> {
    setTesting(true);
    try {
      const r = await accessTest();
      setTestResult(r as unknown as TlsHealthResponse);
    } finally {
      setTesting(false);
    }
  }

  async function forceRenew(): Promise<void> {
    // resolver is "public-alpn" or "dns-01" for public installs.
    // The renew button is only rendered in the public branch (not in the lan
    // branch above), so tls.resolver will always be a valid publicTlsMode here.
    const res = await fetch("/api/admin/access/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ publicTlsMode: tls!.resolver }),
    });
    if (res.ok) await refresh();
  }

  return (
    <div className="card">
      <h3>Access</h3>

      <div className={`status status-${icon}`}>
        {icon === "ok" ? "✓" : icon === "warn" ? "⚠" : "✗"}{" "}
        <strong>{tls.issuer}</strong>{" "}
        <span className="muted">({tls.resolver})</span>
      </div>

      <p>
        Valid for <code>{tls.domain}</code>
        <br />
        {tls.daysToExpiry === null
          ? "N/A"
          : tls.daysToExpiry >= 0
            ? `Expires in ${tls.daysToExpiry} day${tls.daysToExpiry === 1 ? "" : "s"}`
            : `Expired ${-tls.daysToExpiry} days ago`}
      </p>

      {tls.warnings.length > 0 && (
        <ul className="warnings">
          {tls.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button onClick={() => setShowModal(true)}>Reconfigure access</button>
        <button onClick={() => void forceRenew()}>Force renew</button>
        <button onClick={() => void runTest()} disabled={testing}>
          {testing ? "Testing…" : "Test"}
        </button>
      </div>

      {testResult && (
        <div className="test-result">
          <h4>Test result</h4>
          <pre>{JSON.stringify(testResult, null, 2)}</pre>
        </div>
      )}

      {showModal && (
        <ReconfigureAccessModal
          initialDomain={tls.domain}
          onClose={() => {
            setShowModal(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
};
