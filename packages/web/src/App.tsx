import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Sidebar } from "./components/Sidebar.tsx";
import { Sessions } from "./pages/Sessions.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Backups } from "./pages/Backups.tsx";
import { Admin } from "./pages/Admin.tsx";
import { InstallBackupPage } from "./pages/admin/InstallBackup.tsx";
import { WorkspaceBackupPage } from "./pages/admin/WorkspaceBackup.tsx";
import { UpdatesPage } from "./pages/admin/Updates.tsx";
import { AgentAuthAudit } from "./pages/admin/AgentAuthAudit.tsx";
import { Integrations } from "./pages/Integrations.tsx";
import { Packages } from "./pages/Packages.tsx";
import { Secrets } from "./pages/Secrets.tsx";
import { Deployments } from "./pages/Deployments.tsx";
import { Login } from "./pages/Login.tsx";
import { useAuthStore } from "./stores/auth.ts";
import { MigrationBanner } from "./components/access/MigrationBanner.js";

function Layout() {
  return (
    <div className="flex h-screen overflow-hidden flex-col">
      <MigrationBanner />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          <Routes>
          <Route path="/" element={<Sessions />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/deployments" element={<Deployments />} />
          <Route path="/backups" element={<Backups />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/packages" element={<Packages />} />
          <Route path="/secrets" element={<Secrets />} />
          <Route path="/admin/users" element={<Admin />} />
          <Route path="/admin/install-backup" element={<InstallBackupPage />} />
          <Route path="/admin/workspace-backup" element={<WorkspaceBackupPage />} />
          <Route path="/admin/updates" element={<UpdatesPage />} />
          <Route path="/admin/agent-auth" element={<AgentAuthAudit />} />
        </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { user, loading, checkAuth } = useAuthStore();

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="text-zinc-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}
