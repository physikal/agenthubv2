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
  | "tls-email"
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
          setStep(next.domain === "localhost" ? "admin" : "tls-email");
        }}
      />
    );
  }

  if (step === "tls-email") {
    return (
      <PromptStep
        prompt="Email for Let's Encrypt cert notifications:"
        initial={cfg.tlsEmail}
        onSubmit={(v) => {
          setCfg({ ...cfg, tlsEmail: v.trim() });
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
