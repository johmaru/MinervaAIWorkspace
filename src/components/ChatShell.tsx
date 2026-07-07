"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatWindow } from "@/components/ChatWindow";
import { AnimatePresence, motion } from "motion/react";
import { FolderSettingsModal } from "@/components/FolderSettingsModal";
import { HelpModal } from "@/components/HelpModal";
import { useThreads } from "@/hooks/useThreads";
import { useFolders, type FolderSummary } from "@/hooks/useFolders";
import { useI18n } from "@/components/I18nProvider";

const ACTIVE_THREAD_STORAGE_KEY = "umanschat-active-thread";

/**
 * アプリ全体のシェル。アクティブスレッド状態をここで保持し、
 * Sidebar（一覧 + 選択）と ChatWindow（単一会話）に配る。
 *
 * フォルダ機能: useFolders でフォルダ一覧を管理し、
 * Sidebar の右クリック操作でフォルダ CRUD + スレッド移動を行う。
 */
export function ChatShell() {
  const { threads, isLoading, error, refresh, create, rename, remove, move } =
    useThreads();
  const {
    folders,
    isLoading: foldersLoading,
    error: foldersError,
    create: createFolder,
    update: updateFolder,
    remove: removeFolder,
    refresh: refreshFolders,
  } = useFolders();
  const { t } = useI18n();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // folder: null = 新規作成モード（DB 作成は保存時まで遅延）
  const [folderModal, setFolderModal] = useState<{
    folder: FolderSummary | null;
  } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState<string | null>(null);

  const closeHelp = useCallback(() => setHelpOpen(false), []);

  // #29: 最後に選択したスレッドを localStorage に保存・復元
  // マウント時に復元（threads ロード後に有効性チェック）
  useEffect(() => {
    if (threads.length === 0) return;
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY)
        : null;
    if (saved && threads.some((t) => t.id === saved) && !activeThreadId) {
      setActiveThreadId(saved);
    }
    // 復元は初回のみ。activeThreadId 依存しない（一度設定したら再上書きしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  // activeThreadId 変更時に localStorage へ永続化
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeThreadId) {
      window.localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY, activeThreadId);
    } else {
      window.localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY);
    }
  }, [activeThreadId]);

  const openHelp = useCallback((topic: string | null = null) => {
    setHelpTopic(topic);
    setHelpOpen(true);
  }, []);

  const handleCreateThread = useCallback(
    async (): Promise<string | null> => {
      const thread = await create();
      if (thread) {
        setActiveThreadId(thread.id);
        void refresh();
        return thread.id;
      }
      return null;
    },
    [create, refresh],
  );

  const handleNewChat = useCallback(async () => {
    await handleCreateThread();
    setSidebarOpen(false);
  }, [handleCreateThread]);

  const handleSelect = useCallback((id: string) => {
    setActiveThreadId(id);
    setSidebarOpen(false);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await remove(id);
      if (!ok) return;
      if (activeThreadId === id) {
        setActiveThreadId(null);
      }
      void refresh();
    },
    [remove, activeThreadId, refresh],
  );

  const handleRenamed = useCallback(() => {
    void refresh();
  }, [refresh]);

  // --- フォルダ操作 ---

  // #16: フォルダ作成をモーダル保存時に遅延。handleCreateFolder はモーダルを開くだけ。
  const handleCreateFolder = useCallback(() => {
    setFolderModal({ folder: null });
  }, []);

  const handleEditFolder = useCallback((folder: FolderSummary) => {
    setFolderModal({ folder });
  }, []);

  // 新規フォルダ作成（モーダル保存時）
  const handleCreateNewFolder = useCallback(
    async (patch: {
      name: string;
      instruction: string | null;
      memoryScope: "folder" | "global";
    }): Promise<boolean> => {
      const f = await createFolder(patch);
      if (f) {
        void refreshFolders();
        return true;
      }
      return false;
    },
    [createFolder, refreshFolders],
  );

  // 既存フォルダ更新（モーダル保存時）
  const handleSaveFolder = useCallback(
    async (patch: {
      name: string;
      instruction: string | null;
      memoryScope: "folder" | "global";
    }): Promise<boolean> => {
      if (!folderModal?.folder) return false;
      const ok = await updateFolder(folderModal.folder.id, patch);
      if (ok) void refreshFolders();
      return ok;
    },
    [folderModal, updateFolder, refreshFolders],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      const ok = await removeFolder(id);
      if (!ok) return;
      void refreshFolders();
      void refresh(); // スレッドの folderId が DB 側で SET NULL になるため一覧更新
    },
    [removeFolder, refreshFolders, refresh],
  );

  const handleMoveThread = useCallback(
    async (threadId: string, folderId: string | null): Promise<boolean> => {
      const ok = await move(threadId, folderId);
      return ok;
    },
    [move],
  );
  const handleCloseSidebar = useCallback(() => setSidebarOpen(false), []);

  // Esc キーでサイドバーを閉じる
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
        )}
      </AnimatePresence>

      {/* サイドバー: md 以上は常時表示、未満はオーバーレイ */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          threads={threads}
          folders={folders}
          isLoading={isLoading}
          error={error}
          foldersLoading={foldersLoading}
          foldersError={foldersError}
          activeThreadId={activeThreadId}
          onSelect={handleSelect}
          onNewChat={handleNewChat}
          onDelete={handleDelete}
          onRename={rename}
          onRenamed={handleRenamed}
          onSearchSelect={handleSelect}
          onCreateFolder={handleCreateFolder}
          onEditFolder={handleEditFolder}
          onDeleteFolder={handleDeleteFolder}
          onMoveThread={handleMoveThread}
          onClose={handleCloseSidebar}
          onOpenHelp={openHelp}
        />
      </div>

      <main className="flex h-full min-w-0 flex-1 flex-col">
        {/* モバイルヘッダー: ハンバーガーボタン */}
        <div className="flex items-center gap-2 bg-[var(--glass-bg)] px-3 py-2.5 backdrop-blur-md md:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted"
            aria-label={t("sidebar.openSidebar")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="text-sm font-semibold tracking-tight text-foreground">UmansChat</span>
        </div>
        <ChatWindow
          threadId={activeThreadId}
          onCreateThread={handleCreateThread}
          onConversationEnded={handleRenamed}
          onOpenHelp={openHelp}
        />
      </main>

      {folderModal && (
        <FolderSettingsModal
          folder={folderModal.folder}
          open={!!folderModal}
          onClose={() => setFolderModal(null)}
          onSave={handleSaveFolder}
          onCreate={handleCreateNewFolder}
        />
      )}
      <HelpModal open={helpOpen} onClose={closeHelp} initialTopic={helpTopic} />
    </div>
  );
}
