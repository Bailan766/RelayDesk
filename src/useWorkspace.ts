import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deserializeWorkspace, emptyWorkspace, receiveSubscription, replaceSubscription,
  serializeWorkspace, type SubscriptionDownload, type SubscriptionRequest, type Workspace,
} from "./workspace";

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : fallback;
}

async function download(source: string, request?: SubscriptionRequest): Promise<SubscriptionDownload> {
  if (!isTauri()) throw new Error("请使用桌面应用下载订阅");
  return invoke<SubscriptionDownload>("fetch_subscription", { address: source, request });
}

type RefreshStatus = { pending: boolean; error?: string };

export function useWorkspace() {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const current = useRef(workspace);
  const canWrite = useRef(!isTauri());
  const [ready, setReady] = useState(canWrite.current);
  const [storageError, setStorageError] = useState("");
  const saves = useRef<Promise<void>>(Promise.resolve());
  const [refreshStatus, setRefreshStatus] = useState<Record<string, RefreshStatus>>({});
  const refreshes = useRef(new Map<string, Promise<void>>());
  const lastAttempt = useRef(new Map<string, number>());

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<string | null>("load_subscription").then(raw => {
      if (cancelled) return;
      const value = raw ? deserializeWorkspace(raw) : emptyWorkspace;
      current.current = value;
      canWrite.current = true;
      setWorkspace(value);
      setReady(true);
    }).catch(() => {
      if (!cancelled) setStorageError("读取本地数据失败，已保留原有订阅和配置。");
    });
    return () => { cancelled = true; };
  }, []);

  const commit = useCallback((edit: (previous: Workspace) => Workspace) => {
    const save = saves.current.catch(() => {}).then(async () => {
      if (!canWrite.current) throw new Error("本地工作区尚未加载");
      const previous = current.current;
      const next = edit(previous);
      if (next === previous) return;
      if (isTauri()) await invoke("save_subscription", { data: serializeWorkspace(next) });
      current.current = next;
      setWorkspace(next);
    });
    saves.current = save;
    return save;
  }, []);

  const refresh = useCallback((id: string): Promise<void> => {
    const pending = refreshes.current.get(id);
    if (pending) return pending;
    const profile = current.current.subscriptions.find(item => item.id === id);
    if (!profile?.source) return Promise.resolve();
    lastAttempt.current.set(id, Date.now());
    setRefreshStatus(previous => ({ ...previous, [id]: { pending: true } }));
    const task = download(profile.source, profile.request).then(downloaded => commit(previous => {
      const existing = previous.subscriptions.find(item => item.id === id);
      if (!existing || existing.source !== profile.source || existing.updatedAt !== profile.updatedAt) return previous;
      if (existing.request !== profile.request) throw new Error("请求设置已变更，请重新更新");
      return replaceSubscription(previous, receiveSubscription(downloaded.content, existing.source, downloaded.usage, existing));
    })).then(() => {
      setRefreshStatus(previous => ({ ...previous, [id]: { pending: false } }));
    }).catch(error => {
      const message = errorMessage(error, "订阅更新失败");
      setRefreshStatus(previous => ({ ...previous, [id]: { pending: false, error: message } }));
      throw error;
    }).finally(() => {
      refreshes.current.delete(id);
    });
    refreshes.current.set(id, task);
    return task;
  }, [commit]);

  function configureRequest(id: string, request: SubscriptionRequest) {
    return commit(state => {
      const existing = state.subscriptions.find(profile => profile.id === id);
      if (!existing || (existing.request.route === request.route && existing.request.userAgent === request.userAgent)) return state;
      return {
        ...state,
        subscriptions: state.subscriptions.map(profile => profile.id === id ? { ...profile, request } : profile),
      };
    });
  }

  useEffect(() => {
    if (!ready || !workspace.refreshHours || !isTauri()) return;
    async function refreshDue() {
      const interval = current.current.refreshHours * 3_600_000;
      if (!interval) return;
      const due = current.current.subscriptions.filter(profile => profile.source
        && Date.now() - (profile.updatedAt ?? 0) >= interval
        && Date.now() - (lastAttempt.current.get(profile.id) ?? 0) >= 15 * 60_000);
      for (const profile of due) {
        if (!current.current.refreshHours) break;
        if (Date.now() - (lastAttempt.current.get(profile.id) ?? 0) < 15 * 60_000) continue;
        await refresh(profile.id).catch(() => {});
      }
    }
    void refreshDue();
    const timer = window.setInterval(() => void refreshDue(), 60_000);
    return () => window.clearInterval(timer);
  }, [ready, refresh, workspace.refreshHours]);

  async function add(raw: string, request?: SubscriptionRequest) {
    const text = raw.trim();
    if (!canWrite.current) throw new Error("本地工作区尚未加载");
    const source = /^https?:\/\//i.test(text) ? new URL(text).href : "";
    const previous = source ? current.current.subscriptions.find(item => item.source === source) : undefined;
    if (previous) {
      if (request) {
        await configureRequest(previous.id, request);
        await refreshes.current.get(previous.id)?.catch(() => {});
      }
      return refresh(previous.id);
    }
    const downloaded = source ? await download(source, request) : { content: text, usage: null };
    const subscription = receiveSubscription(downloaded.content, source, downloaded.usage, undefined, source ? request : undefined);
    await commit(state => source && state.subscriptions.some(item => item.source === source)
      ? state
      : replaceSubscription(state, subscription));
  }

  return { workspace, ready, storageError, commit, add, refresh, refreshStatus, configureRequest };
}
