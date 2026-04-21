import { create } from "zustand";
import { api } from "../lib/api.ts";

export interface Session {
  id: string;
  name: string;
  status: string;
  statusDetail: string;
  userId: string | null;
  lxcVmid: number | null;
  lxcNode: string | null;
  lxcIp: string | null;
  repo: string | null;
  prompt: string | null;
  createdAt: string;
  endedAt: string | null;
}

interface SessionsResponse {
  active: Session[];
  completed: Session[];
  older: Session[];
}

interface SessionStore {
  active: Session[];
  completed: Session[];
  older: Session[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;

  fetchSessions: () => Promise<void>;
  createSession: (input: {
    name: string;
    repo?: string | undefined;
    prompt?: string | undefined;
  }) => Promise<Session>;
  endSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  selectSession: (id: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  active: [],
  completed: [],
  older: [],
  selectedId: null,
  loading: false,
  error: null,

  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const data = (await res.json()) as SessionsResponse;
      set({
        active: data.active,
        completed: data.completed,
        older: data.older,
        loading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch sessions",
        loading: false,
      });
    }
  },

  createSession: async (input) => {
    const res = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${String(res.status)}`);
    }
    const session = (await res.json()) as Session;
    set((state) => ({ active: [...state.active, session] }));
    return session;
  },

  endSession: async (id) => {
    await api(`/api/sessions/${id}/end`, { method: "POST" });
    set((state) => ({
      active: state.active.filter((s) => s.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    }));
  },

  deleteSession: async (id) => {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    set((state) => ({
      active: state.active.filter((s) => s.id !== id),
      completed: state.completed.filter((s) => s.id !== id),
      older: state.older.filter((s) => s.id !== id),
    }));
  },

  selectSession: (id) => set({ selectedId: id }),
}));
