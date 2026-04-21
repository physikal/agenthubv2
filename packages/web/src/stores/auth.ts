import { create } from "zustand";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin";
}

interface AuthStore {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  loading: true,
  error: null,

  checkAuth: async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const user = (await res.json()) as AuthUser;
        set({ user, loading: false });
      } else {
        set({ user: null, loading: false });
      }
    } catch {
      set({ user: null, loading: false });
    }
  },

  login: async (username, password) => {
    set({ error: null });
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      set({ error: body.error ?? "Login failed" });
      throw new Error(body.error ?? "Login failed");
    }

    const user = (await res.json()) as AuthUser;
    set({ user, error: null });
  },

  logout: async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    set({ user: null });
  },
}));
