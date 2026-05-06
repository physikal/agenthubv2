import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  emptyConfig,
  type InstallConfig,
  type ProvisionerMode,
} from "./lib/config.js";
import { checkPrereqs, type PrereqResult } from "./lib/prereq.js";
import { runInstall, type InstallArtifacts } from "./run.js";

type Step =
  | "welcome"
  | "prereq"
  | "mode"
  | "domain"
  | "tls-strategy"
  | "tls-email"
  | "tls-dns"
  | "tls-self-ca"
  | "dokploy-remote"
  | "admin"
  | "confirm"
  | "run"
  | "done";

export const App: React.FC = () => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("welcome");
  const [cfg, setCfg] = useState<InstallConfig>(() => emptyConfig());
  const [prereq, setPrereq] = useState<PrereqResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [artifacts, setArtifacts] = useState<InstallArtifacts | null>(null);
  const [error, setError] = useState<string>("");

  // Auto-advance the welcome step after a tick so the banner is visible.
  useEffect(() => {
    if (step === "welcome") {
      const t = setTimeout(() => setStep("prereq"), 800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [step]);

  useEffect(() => {
    if (step !== "prereq") return;
    void checkPrereqs({ requirePorts: [80, 443] }).then((r) => {
      setPrereq(r);
    });
  }, [step]);

  if (step === "welcome") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">AgentHub v2 installer</Text>
        <Text dimColor>Self-hostable platform for coding-agent sessions.</Text>
      </Box>
    );
  }

  if (step === "prereq") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Checking prerequisites…</Text>
        {!prereq ? (
          <Text>
            <Spinner type="dots" /> probing docker + ports 80/443
          </Text>
        ) : (
          <>
            {prereq.checks.map((c) => (
              <Text key={c.name}>
                {c.ok ? "✓" : "✗"} {c.name} — {c.detail}
              </Text>
            ))}
            <Box marginTop={1}>
              {prereq.ok ? (
                <SelectInput
                  items={[{ label: "Continue", value: "ok" }]}
                  onSelect={() => setStep("mode")}
                />
              ) : (
                <Text color="red">
                  Fix the items above and re-run. Exiting.
                </Text>
              )}
            </Box>
            {!prereq.ok && <ExitAfter exit={exit} />}
          </>
        )}
      </Box>
    );
  }

  if (step === "mode") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>How should AgentHub provision workspace containers?</Text>
        <SelectInput
          items={[
            { label: "Local Docker (default, simplest)", value: "docker" },
            { label: "Remote Dokploy (URL + API token)", value: "dokploy-remote" },
          ]}
          onSelect={(item) => {
            setCfg({ ...cfg, mode: item.value as ProvisionerMode });
            setStep("domain");
          }}
        />
      </Box>
    );
  }

  if (step === "domain") {
    return (
      <PromptStep
        prompt="Domain (use 'localhost' for local-only):"
        initial={cfg.domain}
        onSubmit={(v) => {
          const next = { ...cfg, domain: v.trim() || "localhost" };
          setCfg(next);
          setStep(next.domain === "localhost" ? "admin" : "tls-strategy");
        }}
      />
    );
  }

  if (step === "tls-strategy") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>How should TLS work for {cfg.domain}?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              {
                label:
                  "Public ACME — Let's Encrypt cert. Needs port 443 reachable from the public internet.",
                value: "public-alpn",
              },
              {
                label:
                  "DNS challenge — Let's Encrypt cert via your DNS provider's API. Use this for internal-only hosts.",
                value: "dns-01",
              },
              {
                label:
                  "Self-signed CA — generate a private CA on this host. (Plan 3 — not yet wired up.)",
                value: "self-ca",
              },
            ]}
            onSelect={(item) => {
              const tlsMode = item.value as "public-alpn" | "dns-01" | "self-ca";
              setCfg({ ...cfg, tlsMode });
              if (tlsMode === "self-ca") {
                setStep("tls-self-ca");
              } else {
                setStep("tls-email");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "tls-email") {
    return (
      <PromptStep
        prompt="Email for Let's Encrypt cert notifications:"
        initial={cfg.tlsEmail}
        onSubmit={(v) => {
          const next = { ...cfg, tlsEmail: v.trim() };
          setCfg(next);
          if (next.tlsMode === "dns-01") {
            setStep("tls-dns");
          } else if (cfg.mode === "dokploy-remote") {
            setStep("dokploy-remote");
          } else {
            setStep("admin");
          }
        }}
      />
    );
  }

  if (step === "tls-dns") {
    return (
      <TlsDnsStep
        cfg={cfg}
        onDone={(next) => {
          setCfg(next);
          setStep(cfg.mode === "dokploy-remote" ? "dokploy-remote" : "admin");
        }}
        onAbort={(msg) => {
          setError(msg);
          setStep("done");
        }}
      />
    );
  }

  if (step === "tls-self-ca") {
    return (
      <TlsSelfCaStep
        cfg={cfg}
        onDone={(next) => {
          setCfg(next);
          setStep(cfg.mode === "dokploy-remote" ? "dokploy-remote" : "admin");
        }}
      />
    );
  }

  if (step === "dokploy-remote") {
    return (
      <DokployRemoteStep
        cfg={cfg}
        onDone={(next) => {
          setCfg(next);
          setStep("admin");
        }}
      />
    );
  }

  if (step === "admin") {
    return (
      <PromptStep
        prompt="Admin password (leave blank to generate a random one):"
        initial={cfg.adminPassword}
        mask
        onSubmit={(v) => {
          setCfg({ ...cfg, adminPassword: v });
          setStep("confirm");
        }}
      />
    );
  }

  if (step === "confirm") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Ready to install with:</Text>
        <Text>  mode: {cfg.mode}</Text>
        <Text>  domain: {cfg.domain}</Text>
        <Text>
          {"  "}TLS:{" "}
          {cfg.domain === "localhost"
            ? "default cert (localhost)"
            : cfg.tlsMode === "dns-01"
              ? `dns-01 (${cfg.tlsDnsProvider || "?"})`
              : cfg.tlsMode}
        </Text>
        {cfg.tlsEmail && <Text>  TLS email: {cfg.tlsEmail}</Text>}
        {cfg.mode === "dokploy-remote" && (
          <Text>  Dokploy: {cfg.dokployUrl}</Text>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "Install now", value: "go" },
              { label: "Quit", value: "exit" },
            ]}
            onSelect={(item) => {
              if (item.value === "exit") {
                exit();
              } else {
                setStep("run");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "run") {
    return (
      <RunStep
        cfg={cfg}
        onLog={(line) => setLogs((l) => [...l.slice(-8), line])}
        onDone={(art) => {
          setArtifacts(art);
          setStep("done");
        }}
        onError={(msg) => {
          setError(msg);
          setStep("done");
        }}
        logs={logs}
      />
    );
  }

  if (step === "done") {
    if (error) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>Install failed:</Text>
          <Text>{error}</Text>
          <ExitAfter exit={exit} ms={200} />
        </Box>
      );
    }
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">AgentHub v2 is up.</Text>
        {artifacts && (
          <>
            <Text>URL: {artifacts.url}</Text>
            <Text>Admin user: admin</Text>
            <Text>Admin password: {artifacts.adminPassword}</Text>
            <Box marginTop={1} />
            <Text dimColor>Infisical console: https://secrets.{cfg.domain}/</Text>
            <Text dimColor>  email: {artifacts.infisicalAdminEmail}</Text>
            <Text dimColor>  password: {artifacts.infisicalAdminPassword}</Text>
            <Box marginTop={1} />
            <Text dimColor>Credentials also written to .env.</Text>
          </>
        )}
        <ExitAfter exit={exit} ms={500} />
      </Box>
    );
  }

  return null;
};

// ---------- step helpers ----------

const ExitAfter: React.FC<{ exit: () => void; ms?: number }> = ({ exit, ms = 300 }) => {
  useEffect(() => {
    const t = setTimeout(() => exit(), ms);
    return () => clearTimeout(t);
  }, [exit, ms]);
  return null;
};

const PromptStep: React.FC<{
  prompt: string;
  initial: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
}> = ({ prompt, initial, mask, onSubmit }) => {
  const [value, setValue] = useState(initial);
  return (
    <Box flexDirection="column" padding={1}>
      <Text>{prompt}</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} {...(mask ? { mask: "•" } : {})} />
      </Box>
    </Box>
  );
};

const TlsDnsStep: React.FC<{
  cfg: InstallConfig;
  onDone: (next: InstallConfig) => void;
  onAbort: (msg: string) => void;
}> = ({ cfg, onDone, onAbort }) => {
  type Sub = "provider" | "cloudflare-token" | "other-name";
  const [sub, setSub] = useState<Sub>("provider");
  const [token, setToken] = useState("");
  const [otherName, setOtherName] = useState("");

  if (sub === "provider") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>DNS provider for ACME challenge:</Text>
        <SelectInput
          items={[
            { label: "Cloudflare", value: "cloudflare" },
            { label: "Other (lego provider)", value: "other" },
          ]}
          onSelect={(item) => {
            if (item.value === "cloudflare") {
              setSub("cloudflare-token");
            } else {
              setSub("other-name");
            }
          }}
        />
      </Box>
    );
  }

  if (sub === "cloudflare-token") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Cloudflare API token (DNS:Edit on the zone):</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={token}
            onChange={setToken}
            mask="•"
            onSubmit={(v) => {
              const t = v.trim();
              if (!t) return;
              const next: InstallConfig = {
                ...cfg,
                tlsDnsProvider: "cloudflare",
                tlsDnsEnvVars: { ...cfg.tlsDnsEnvVars, CF_DNS_API_TOKEN: t },
              };
              void (async () => {
                const { preflightCloudflare } = await import(
                  "./lib/tls/preflight.js"
                );
                const pf = await preflightCloudflare(t, cfg.domain);
                if (!pf.ok) {
                  onAbort(`Cloudflare pre-flight failed: ${pf.reason}`);
                  return;
                }
                onDone(next);
              })();
            }}
          />
        </Box>
      </Box>
    );
  }

  // other-name
  return (
    <Box flexDirection="column" padding={1}>
      <Text>lego provider name (e.g. route53, hetzner):</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={otherName}
          onChange={setOtherName}
          onSubmit={(v) => {
            const provider = v.trim().toLowerCase();
            if (!provider) return;
            void (async () => {
              const { requiredEnvVarsFor } = await import(
                "./lib/tls/lego-providers.js"
              );
              const required = requiredEnvVarsFor(provider);
              if (!required) {
                onAbort(
                  `'${provider}' isn't in our lego manifest. Set its env vars in your shell and re-run with AGENTHUB_TLS_DNS_PROVIDER=${provider}; we'll forward them verbatim.`,
                );
                return;
              }
              const present: Record<string, string> = {};
              const missing: string[] = [];
              for (const name of required) {
                const val = process.env[name];
                if (val) present[name] = val;
                else missing.push(name);
              }
              if (missing.length > 0) {
                onAbort(
                  `Missing env vars for ${provider}: ${missing.join(", ")}. ` +
                    `Export them in your shell and re-run the installer.`,
                );
                return;
              }
              onDone({
                ...cfg,
                tlsDnsProvider: provider,
                tlsDnsEnvVars: { ...cfg.tlsDnsEnvVars, ...present },
              });
            })();
          }}
        />
      </Box>
    </Box>
  );
};

const TlsSelfCaStep: React.FC<{
  cfg: InstallConfig;
  onDone: (next: InstallConfig) => void;
}> = ({ cfg, onDone }) => {
  // Lazy lookup so we don't pull node:os into the initial bundle.
  const [detected, setDetected] = useState<string>("");
  const [picking, setPicking] = useState<"choose" | "edit">("choose");
  const [override, setOverride] = useState("");

  useEffect(() => {
    void (async () => {
      const { detectLanIp } = await import("./lib/tls/lan-ip.js");
      const ip = detectLanIp();
      setDetected(ip);
      setOverride(ip);
    })();
  }, []);

  if (!detected) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>
          <Spinner type="dots" /> detecting LAN IP…
        </Text>
      </Box>
    );
  }

  if (picking === "choose") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Self-CA leaf cert SAN</Text>
        <Text>Detected LAN IP: <Text color="cyan">{detected}</Text></Text>
        <Text>
          Cert will cover{" "}
          <Text color="cyan">{cfg.domain}</Text>,{" "}
          <Text color="cyan">*.{cfg.domain}</Text>, and the LAN IP above —
          so direct-IP access works without a hostname mismatch.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: `Use detected IP (${detected})`, value: "use" },
              { label: "Enter different IP / list (comma-separated)", value: "edit" },
            ]}
            onSelect={(item) => {
              if (item.value === "use") {
                onDone({ ...cfg, lanIp: detected });
              } else {
                setPicking("edit");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text>LAN IPs (comma-separated, e.g. 192.168.4.36,10.0.0.1):</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={override}
          onChange={setOverride}
          onSubmit={(v) => {
            onDone({ ...cfg, lanIp: v.trim() || detected });
          }}
        />
      </Box>
    </Box>
  );
};

const DokployRemoteStep: React.FC<{
  cfg: InstallConfig;
  onDone: (next: InstallConfig) => void;
}> = ({ cfg, onDone }) => {
  const [sub, setSub] = useState<"url" | "token" | "project" | "env">("url");
  const [value, setValue] = useState(cfg.dokployUrl);
  const [scratch, setScratch] = useState<Partial<InstallConfig>>({});

  const prompts: Record<typeof sub, string> = {
    url: "Dokploy URL (https://...):",
    token: "Dokploy API token:",
    project: "Dokploy project ID:",
    env: "Dokploy environment ID:",
  };

  const submit = (v: string): void => {
    const val = v.trim();
    if (sub === "url") {
      setScratch({ ...scratch, dokployUrl: val });
      setValue(cfg.dokployApiToken);
      setSub("token");
    } else if (sub === "token") {
      setScratch({ ...scratch, dokployApiToken: val });
      setValue(cfg.dokployProjectId);
      setSub("project");
    } else if (sub === "project") {
      setScratch({ ...scratch, dokployProjectId: val });
      setValue(cfg.dokployEnvironmentId);
      setSub("env");
    } else {
      onDone({ ...cfg, ...scratch, dokployEnvironmentId: val });
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text>{prompts[sub]}</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          {...(sub === "token" ? { mask: "•" } : {})}
        />
      </Box>
    </Box>
  );
};

const RunStep: React.FC<{
  cfg: InstallConfig;
  logs: string[];
  onLog: (line: string) => void;
  onDone: (art: InstallArtifacts) => void;
  onError: (msg: string) => void;
}> = ({ cfg, logs, onLog, onDone, onError }) => {
  useEffect(() => {
    let cancelled = false;
    runInstall(cfg, onLog)
      .then((art) => {
        if (!cancelled) onDone(art);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "unknown";
          onError(msg);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cfg, onDone, onError, onLog]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text>
        <Spinner type="dots" /> Installing…
      </Text>
      {logs.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
    </Box>
  );
};
