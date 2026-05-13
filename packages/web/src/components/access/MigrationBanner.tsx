import React, { useEffect, useState } from "react";
import { getHealth } from "../../lib/api.js";
import { ReconfigureAccessModal } from "./ReconfigureAccessModal.js";

const DISMISS_KEY = "agenthub:tls-migration-banner-dismissed-v1";

export const MigrationBanner: React.FC = () => {
  const [show, setShow] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [domain, setDomain] = useState("");

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "true") return;
    void (async () => {
      const h = await getHealth();
      if (h.tls && h.tls.resolver === "default-fallback") {
        setShow(true);
        setDomain(h.tls.domain);
      }
    })();
  }, []);

  if (!show) return null;

  function dismiss(): void {
    localStorage.setItem(DISMISS_KEY, "true");
    setShow(false);
  }

  return (
    <div className="migration-banner">
      <span>
        ⚠ TLS misconfigured — your site is serving Traefik's default
        self-signed cert. Run <code>agenthub reconfigure-access</code> to fix.
      </span>
      <button onClick={() => setShowModal(true)}>Fix now</button>
      <button onClick={dismiss}>Dismiss</button>

      {showModal && (
        <ReconfigureAccessModal
          initialDomain={domain}
          defaultLanIp=""
          onClose={() => {
            setShowModal(false);
            void getHealth().then((h) => {
              if (h.tls && h.tls.resolver !== "default-fallback") {
                setShow(false);
              }
            });
          }}
        />
      )}
    </div>
  );
};
