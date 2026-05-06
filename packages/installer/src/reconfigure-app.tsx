import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findComposeDir } from "./lib/compose.js";
import { runReconfigure, type ReconfigureConfig, type ReconfigureOptions } from "./reconfigure.js";

interface ParsedEnv {
  domain: string;
  tlsEmail: string;
  tlsDnsProvider: string;
  cfApiToken: string;
  lanIp: string;
}

function readExistingEnv(composeDir: string): ParsedEnv {
  const text = readFileSync(join(composeDir, ".env"), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]!] = m[2]!;
  }
  return {
    domain: env["DOMAIN"] ?? "localhost",
    tlsEmail: env["TLS_EMAIL"] ?? "",
    tlsDnsProvider: env["AGENTHUB_TLS_DNS_PROVIDER"] ?? "",
    cfApiToken: env["CF_DNS_API_TOKEN"] ?? "",
    lanIp: env["AGENTHUB_LAN_IP"] ?? "",
  };
}

type Step = "strategy" | "email" | "dns-token" | "self-ca-ip" | "running" | "done";

const ReconfigureApp: React.FC<{ opts: ReconfigureOptions }> = ({ opts }) => {
  const { exit } = useApp();
  const composeDir = findComposeDir();
  const initial = readExistingEnv(composeDir);

  const [step, setStep] = useState<Step>(initial.domain === "localhost" ? "done" : "strategy");
  const [mode, setMode] = useState<"public-alpn" | "dns-01" | "self-ca">("public-alpn");
  const [tlsEmail, setTlsEmail] = useState(initial.tlsEmail);
  const [cfApiToken, setCfApiToken] = useState(initial.cfApiToken);
  const [lanIp, setLanIp] = useState(initial.lanIp);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");

  if (initial.domain === "localhost") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">
          reconfigure-tls is not supported for localhost installs.
        </Text>
        <ExitAfter exit={exit} />
      </Box>
    );
  }

  if (step === "strategy") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>How should TLS work for {initial.domain}?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "Public ACME (TLS-ALPN-01)", value: "public-alpn" },
              { label: "DNS-01 (Cloudflare)", value: "dns-01" },
              { label: "Self-signed CA", value: "self-ca" },
            ]}
            onSelect={(item) => {
              const v = item.value as typeof mode;
              setMode(v);
              if (v === "public-alpn") setStep("email");
              else if (v === "dns-01") setStep("email");
              else setStep("self-ca-ip");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "email") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>TLS email (current: {tlsEmail || "(unset)"}):</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={tlsEmail}
            onChange={setTlsEmail}
            onSubmit={(v) => {
              setTlsEmail(v.trim());
              setStep(mode === "dns-01" ? "dns-token" : "running");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "dns-token") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Cloudflare API token:</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={cfApiToken}
            onChange={setCfApiToken}
            mask="•"
            onSubmit={(v) => {
              setCfApiToken(v.trim());
              setStep("running");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "self-ca-ip") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>LAN IPs (comma-separated):</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={lanIp}
            onChange={setLanIp}
            onSubmit={(v) => {
              setLanIp(v.trim());
              setStep("running");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "running") {
    return (
      <RunningStep
        cfg={{
          mode,
          domain: initial.domain,
          tlsEmail,
          tlsDnsProvider: mode === "dns-01" ? "cloudflare" : "",
          tlsDnsEnvVars:
            mode === "dns-01" && cfApiToken
              ? { CF_DNS_API_TOKEN: cfApiToken }
              : {},
          lanIp,
        }}
        opts={opts}
        onLog={(line) => setLogs((cur) => [...cur.slice(-10), line])}
        onDone={(err) => {
          if (err) setError(err);
          setStep("done");
        }}
        logs={logs}
      />
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      {error ? (
        <>
          <Text color="red" bold>Reconfigure failed:</Text>
          <Text>{error}</Text>
        </>
      ) : (
        <Text color="green">Reconfigure complete.</Text>
      )}
      <ExitAfter exit={exit} />
    </Box>
  );
};

const RunningStep: React.FC<{
  cfg: ReconfigureConfig;
  opts: ReconfigureOptions;
  logs: string[];
  onLog: (line: string) => void;
  onDone: (err: string | null) => void;
}> = ({ cfg, opts, logs, onLog, onDone }) => {
  useEffect(() => {
    let cancelled = false;
    runReconfigure(cfg, onLog, opts)
      .then(() => {
        if (!cancelled) onDone(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) onDone(err instanceof Error ? err.message : "unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [cfg, onDone, onLog, opts]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text>
        <Spinner type="dots" /> Applying TLS reconfiguration…
      </Text>
      {logs.map((l, i) => (
        <Text key={i} dimColor>{l}</Text>
      ))}
    </Box>
  );
};

const ExitAfter: React.FC<{ exit: () => void; ms?: number }> = ({
  exit,
  ms = 500,
}) => {
  useEffect(() => {
    const t = setTimeout(() => exit(), ms);
    return () => clearTimeout(t);
  }, [exit, ms]);
  return null;
};

export default function launchReconfigureApp(
  opts: ReconfigureOptions,
): Promise<void> {
  return new Promise((resolveDone) => {
    const { waitUntilExit } = render(<ReconfigureApp opts={opts} />);
    void waitUntilExit().then(() => resolveDone());
  });
}
