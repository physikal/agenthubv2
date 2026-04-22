import { NavLink } from "react-router-dom";
import { useAuthStore } from "../stores/auth.ts";

const links = [
  { to: "/", label: "My Sessions", icon: "●" },
  { to: "/deployments", label: "Deployments", icon: "●" },
  { to: "/backups", label: "Backups", icon: "●" },
  { to: "/integrations", label: "Integrations", icon: "●" },
  { to: "/settings", label: "Settings", icon: "●" },
] as const;

const adminLinks = [
  { to: "/admin/users", label: "Users", icon: "●" },
] as const;

export function Sidebar() {
  const { user, logout } = useAuthStore();

  return (
    <aside className="w-72 border-r border-zinc-800 bg-zinc-900 flex flex-col">
      <div className="p-5 border-b border-zinc-800">
        <h1 className="text-xl font-semibold">
          <span className="text-purple-400">agent</span>
          <span className="text-zinc-100">hub</span>
        </h1>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-purple-500/10 text-purple-400 font-medium"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`
            }
          >
            <span
              className={`text-[8px] ${
                link.to === "/" ? "text-purple-400" : "text-zinc-600"
              }`}
            >
              {link.icon}
            </span>
            {link.label}
          </NavLink>
        ))}

        {user?.role === "admin" && (
          <>
            <div className="pt-3 pb-1 px-4">
              <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">
                Admin
              </span>
            </div>
            {adminLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-purple-500/10 text-purple-400 font-medium"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  }`
                }
              >
                <span className="text-[8px] text-zinc-600">{link.icon}</span>
                {link.label}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      <div className="p-3 border-t border-zinc-800">
        <div className="flex items-center justify-between px-2">
          <div className="min-w-0">
            <p className="text-xs text-zinc-300 truncate">
              {user?.displayName ?? user?.username}
            </p>
            <p className="text-[10px] text-zinc-600">
              {user?.role === "admin" ? "Admin" : "User"}
            </p>
          </div>
          <button
            onClick={() => void logout()}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          >
            Logout
          </button>
        </div>
        <div className="mt-2 px-2">
          <span className="text-[10px] text-zinc-600">
            v{__BUILD_VERSION__}
          </span>
        </div>
      </div>
    </aside>
  );
}

declare const __BUILD_VERSION__: string;
