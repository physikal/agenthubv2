import React from "react";
import { render, Text, Box } from "ink";

const App: React.FC = () => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      AgentHub installer (scaffold)
    </Text>
    <Text dimColor>
      Full installer flow lands in Phase 6. This scaffold exists so the
      monorepo builds end-to-end.
    </Text>
  </Box>
);

render(<App />);
