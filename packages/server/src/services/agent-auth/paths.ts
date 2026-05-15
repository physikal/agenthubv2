const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_ID_RE = /^[a-z0-9-]{1,64}$/;

export function validateUserId(userId: string): string {
  if (!USER_ID_RE.test(userId)) throw new Error(`invalid userId: ${userId}`);
  return userId;
}

export function validateToolId(toolId: string): string {
  if (!TOOL_ID_RE.test(toolId)) throw new Error(`invalid toolId: ${toolId}`);
  return toolId;
}

export function agentCredentialPath(userId: string, toolId: string): string {
  return `/users/${validateUserId(userId)}/agents/${validateToolId(toolId)}`;
}

export const CREDENTIAL_SECRET_NAME = "credentials";
