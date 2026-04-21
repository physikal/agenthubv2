import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Sidebar } from "./components/Sidebar.tsx";
import { Sessions } from "./pages/Sessions.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Backups } from "./pages/Backups.tsx";
import { Admin } from "./pages/Admin.tsx";
import { Infrastructure } from "./pages/Infrastructure.tsx";
import { Deployments } from "./pages/Deployments.tsx";
import { Login } from "./pages/Login.tsx";
import { useAuthStore } from "./stores/auth.ts";

function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0 min-w-0">
        <Routes>
          <Route path="/" element={<Sessions />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/deployments" element={<Deployments />} />
          <Route path="/backups" element={<Backups />} />
          <Route path="/infrastructure" element={<Infrastructure />} />
          <Route path="/admin/users" element={<Admin />} />
          <Route path="/containers" element={<div className="p-6">Containers</div>} />
        </Routes>
      </main>
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
