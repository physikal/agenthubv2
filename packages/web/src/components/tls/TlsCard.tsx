import React, { useEffect, useState } from "react";
import {
  getHealth,
  tlsTest,
  type TlsHealthResponse,
} from "../../lib/api.js";
import { ReconfigureTlsModal } from "./ReconfigureTlsModal.js";

function statusIcon(tls: TlsHealthResponse): "ok" | "warn" | "error" {
  if (!tls.ok) return "error";
  if (tls.warnings.length > 0) return "warn";
  return "ok";
}

export const TlsCard: React.FC = () => {
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
        <h3>TLS</h3>
        <p className="muted">No TLS data (localhost install or probe pending).</p>
      </div>
    );
  }

  const icon = statusIcon(tls);

  async function runTest(): Promise<void> {
    setTesting(true);
    try {
      const r = await tlsTest();
      setTestResult(r as unknown as TlsHealthResponse);
    } finally {
      setTesting(false);
    }
  }

  async function forceRenew(): Promise<void> {
    const res = await fetch("/api/admin/tls/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: tls!.resolver }),
    });
    if (res.ok) await refresh();
  }

  return (
    <div className="card">
      <h3>TLS</h3>

      <div className={`status status-${icon}`}>
        {icon === "ok" ? "✓" : icon === "warn" ? "⚠" : "✗"}{" "}
        <strong>{tls.issuer}</strong>{" "}
        <span className="muted">({tls.resolver})</span>
      </div>

      <p>
        Valid for <code>{tls.domain}</code>
        <br />
        {tls.daysToExpiry >= 0
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
        <button onClick={() => setShowModal(true)}>Reconfigure TLS</button>
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
        <ReconfigureTlsModal
          initialDomain={tls.domain}
          defaultLanIp=""
          onClose={() => {
            setShowModal(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
};
