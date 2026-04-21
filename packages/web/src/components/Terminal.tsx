import { useTerminal } from "../hooks/useTerminal.ts";

interface TerminalProps {
  sessionId: string;
}

export function TerminalView({ sessionId }: TerminalProps) {
  const { attach } = useTerminal({ sessionId });

  return (
    <div ref={attach} className="h-full w-full bg-[#1a1a2e]" />
  );
}
