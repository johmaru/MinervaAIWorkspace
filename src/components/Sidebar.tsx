"use client";

import { memo, useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { AnimateModal, MotionButton } from "@/components/ui/motion";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { SearchBar } from "@/components/SearchBar";
import { UrlInput } from "@/components/UrlInput";
import { SettingsModal } from "@/components/SettingsModal";
import { MemoryViewerModal } from "@/components/MemoryViewerModal";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { MoveToFolderModal } from "@/components/MoveToFolderModal";
import { useI18n } from "@/components/I18nProvider";
import type { ThreadSummary } from "@/hooks/useThreads";
import type { FolderSummary } from "@/hooks/useFolders";

type SidebarProps = {
  threads: ThreadSummary[];
  folders: FolderSummary[];
  isLoading: boolean;
  error: string | null;
  foldersLoading: boolean;
  foldersError: string | null;
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean> | boolean;
  onRenamed: () => void;
  onSearchSelect: (threadId: string) => void;
  onCreateFolder: () => void;
  onEditFolder: (folder: FolderSummary) => void;
  onDeleteFolder: (id: string) => void;
  onMoveThread: (threadId: string, folderId: string | null) => Promise<boolean>;
  onClose?: () => void;
  onOpenHelp: (topic: string | null) => void;
};

type MenuState = { x: number; y: number; items: MenuItem[] };

export const Sidebar = memo(function Sidebar({
  threads,
  folders,
  isLoading,
  error,
  foldersLoading,
  foldersError,
  activeThreadId,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  onRenamed,
  onSearchSelect,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
  onMoveThread,
  onClose,
  onOpenHelp,
}: SidebarProps) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [moveTarget, setMoveTarget] = useState<{
    threadId: string;
    currentFolderId: string | null;
  } | null>(null);
  // #22: 削除確認ダイアログ（React state ベース・テスト可能・スタイル統一）
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "thread" | "folder";
    id: string;
    name: string;
  } | null>(null);

  const toggleFolder = useCallback((id: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 空欄右クリック → 新規フォルダ作成
  function handleNavContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          type: "item",
          label: t("sidebar.newFolder"),
          onClick: onCreateFolder,
        },
      ],
    });
  }

  const handleFolderContextMenu = useCallback(
    (e: React.MouseEvent, folder: FolderSummary) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            type: "item",
            label: t("sidebar.settings"),
            onClick: () => onEditFolder(folder),
          },
          {
            type: "separator",
          },
          {
            type: "item",
            label: t("common.delete"),
            danger: true,
            onClick: () =>
              setPendingDelete({ kind: "folder", id: folder.id, name: folder.name }),
          },
        ],
      });
    },
    [t, onEditFolder, onDeleteFolder],
  );

  const handleThreadContextMenu = useCallback(
    (e: React.MouseEvent, thread: ThreadSummary) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            type: "item",
            label: t("sidebar.moveFolder"),
            onClick: () =>
              setMoveTarget({
                threadId: thread.id,
                currentFolderId: thread.folderId,
              }),
          },
          { type: "separator" },
          {
            type: "item",
            label: t("common.delete"),
            danger: true,
            onClick: () =>
              setPendingDelete({
                kind: "thread",
                id: thread.id,
                name: thread.title,
              }),
          },
        ],
      });
    },
    [t, onDelete],
  );


  // #22: ThreadRow の × ボタンも確認ダイアログを経由する
  const handleThreadDelete = useCallback(
    (id: string) => {
      const thread = threads.find((t) => t.id === id);
      setPendingDelete({ kind: "thread", id, name: thread?.title ?? "" });
    },
    [threads],
  );
  const unassignedThreads = threads.filter((t) => t.folderId === null);

  return (
    <aside
      className="flex h-full w-60 shrink-0 flex-col bg-sidebar glass-card"
      aria-label={t("sidebar.threadList")}
    >
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LanguageToggle />
          <MotionButton
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("sidebar.appSettings")}
            whileTap={{ scale: 0.9 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </MotionButton>
          <MotionButton
            type="button"
            onClick={() => setMemoryOpen(true)}
            className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("sidebar.memory")}
            whileTap={{ scale: 0.9 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.27 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
              <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.27 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
            </svg>
          </MotionButton>
          <MotionButton
            type="button"
            onClick={() => onOpenHelp(null)}
            className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("sidebar.help")}
            whileTap={{ scale: 0.9 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </MotionButton>
          {onClose && (
            <MotionButton
              type="button"
              onClick={onClose}
              className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground md:hidden"
              aria-label={t("sidebar.closeSidebar")}
              whileTap={{ scale: 0.9 }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </MotionButton>
          )}
        </div>
      </div>

      <div className="space-y-1 px-2 py-1">
        <SearchBar onSelectThread={onSearchSelect} />
        <UrlInput />
      </div>

      <div className="px-2">
        <MotionButton
          type="button"
          onClick={onNewChat}
          className="w-full rounded-2xl bg-muted px-3 py-2 text-left text-sm font-medium text-foreground/90 transition-all duration-200 hover:bg-muted/80 hover:text-foreground ring-1 ring-border"
          whileTap={{ scale: 0.9 }}
        >
          {t("sidebar.newChat")}
        </MotionButton>
      </div>

      <nav
        className="mt-2 flex-1 overflow-y-auto px-1"
        aria-label={t("sidebar.threadListNav")}
        onContextMenu={handleNavContextMenu}
      >
        {(isLoading && threads.length === 0) || (foldersLoading && folders.length === 0) ? (
          <p className="px-2 py-4 text-xs text-muted-foreground animate-pulse">{t("common.loading")}</p>
        ) : threads.length === 0 && folders.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            {t("sidebar.noThreads")}
          </p>
        ) : (
          <AnimatePresence>
            <ul className="flex flex-col gap-0.5">
              {/* フォルダセクション */}
              {folders.map((f) => {
                const collapsed = collapsedFolders.has(f.id);
                const folderThreads = threads.filter((t) => t.folderId === f.id);
                return (
                  <motion.li
                    key={f.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={{ duration: 0.2 }}
                  >
                    <FolderRow
                      folder={f}
                      collapsed={collapsed}
                      count={folderThreads.length}
                      onToggle={toggleFolder}
                      onOpenMenu={handleFolderContextMenu}
                    />
                    {!collapsed && (
                      <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1">
                        {folderThreads.length === 0 ? (
                          <li className="px-2 py-1 text-xs text-muted-foreground">
                            {t("sidebar.noThreadsInFolder")}
                          </li>
                        ) : (
                          folderThreads.map((t) => (
                            <ThreadRow
                              key={t.id}
                              thread={t}
                              active={t.id === activeThreadId}
                              onSelect={onSelect}
                              onDelete={handleThreadDelete}
                              onRename={onRename}
                              onRenamed={onRenamed}
                              onContextMenu={handleThreadContextMenu}
                            />
                          ))
                        )}
                      </ul>
                    )}
                  </motion.li>
                );
              })}

              {/* 未割当セクション */}
              {unassignedThreads.length > 0 && (
                <motion.li
                  className="mt-1"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.2 }}
                >
                  {folders.length > 0 && (
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      {t("sidebar.unassigned")}
                    </div>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {unassignedThreads.map((t) => (
                      <ThreadRow
                        key={t.id}
                        thread={t}
                        active={t.id === activeThreadId}
                        onSelect={onSelect}
                        onDelete={handleThreadDelete}
                        onRename={onRename}
                        onRenamed={onRenamed}
                        onContextMenu={handleThreadContextMenu}
                      />
                    ))}
                  </ul>
                </motion.li>
              )}
            </ul>
          </AnimatePresence>
        )}
      </nav>

      {(error || foldersError) && (
        <div className="mx-2 mb-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {t("common.errorPrefix", { error: error || foldersError || "" })}
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onOpenHelp={onOpenHelp} />
      <MemoryViewerModal open={memoryOpen} onClose={() => setMemoryOpen(false)} />

      <AnimatePresence>
        {menu && (
          <ContextMenu
            key="context-menu"
            x={menu.x}
            y={menu.y}
            items={menu.items}
            onClose={() => setMenu(null)}
          />
        )}
      </AnimatePresence>

      <MoveToFolderModal
        open={!!moveTarget}
        threadId={moveTarget?.threadId ?? null}
        currentFolderId={moveTarget?.currentFolderId ?? null}
        folders={folders}
        onClose={() => setMoveTarget(null)}
        onMove={onMoveThread}
      />

      {/* #22: 削除確認ダイアログ */}
      <AnimateModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        ariaLabel={t("common.confirmDelete")}
        panelClassName="max-w-sm"
      >
        <p className="mb-1 text-base font-semibold">
          {t("common.confirmDelete")}
        </p>
        <p className="mb-4 text-sm text-muted-foreground">
          {pendingDelete?.kind === "folder"
            ? t("common.confirmDeleteFolder")
            : t("common.confirmDeleteThread")}
        </p>
        <div className="flex justify-end gap-2">
          <MotionButton
            type="button"
            onClick={() => setPendingDelete(null)}
            className="rounded-xl bg-muted px-3 py-1.5 text-sm transition-all duration-200 hover:bg-muted/80"
          >
            {t("common.cancel")}
          </MotionButton>
          <MotionButton
            type="button"
            onClick={() => {
              if (!pendingDelete) return;
              if (pendingDelete.kind === "folder") onDeleteFolder(pendingDelete.id);
              else onDelete(pendingDelete.id);
              setPendingDelete(null);
            }}
            className="rounded-xl bg-red-500 px-4 py-2 text-sm text-white transition-all duration-200 hover:opacity-90"
          >
            {t("common.delete")}
          </MotionButton>
        </div>
      </AnimateModal>
    </aside>
  );
});

type FolderRowProps = {
  folder: FolderSummary;
  collapsed: boolean;
  count: number;
  onToggle: (id: string) => void;
  /** 右クリック・ケバブボタンどちらからでもメニューを開く */
  onOpenMenu: (e: React.MouseEvent, folder: FolderSummary) => void;
};

const FolderRow = memo(function FolderRow({
  folder,
  collapsed,
  count,
  onToggle,
  onOpenMenu,
}: FolderRowProps) {
  const { t } = useI18n();
  return (
    <div
      className="group flex items-center gap-1 rounded-xl px-1 py-1 transition-all duration-150 hover:bg-muted/70"
      onClick={() => onToggle(folder.id)}
      onContextMenu={(e) => onOpenMenu(e, folder)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(folder.id);
        }
      }}
    >
      <span className={`text-xs text-muted-foreground transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} aria-hidden="true">
        ▶
      </span>
      <span className="flex-1 truncate text-sm font-medium" title={folder.name}>
        {folder.name}
      </span>
      <span
        className="text-xs"
        title={
          folder.memoryScope === "folder"
            ? t("sidebar.memoryScopeThisFolder")
            : t("sidebar.memoryScopeAllThreads")
        }
        aria-label={t("sidebar.memoryScope")}
      >
        {folder.memoryScope === "folder" ? "🔒" : "🌐"}
      </span>
      {folder.instruction && (
        <span className="text-xs" title={t("sidebar.hasInstruction")} aria-label={t("sidebar.hasInstruction")}>
          📝
        </span>
      )}
      <span className="text-xs text-muted-foreground">{count}</span>
      {/* #28: ケバブメニュー（モバイル・キーボードからフォルダ設定/削除にアクセス） */}
      <button
        type="button"
        aria-label={t("sidebar.folderActions")}
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(e, folder);
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
    </div>
  );
});

type ThreadRowProps = {
  thread: ThreadSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean> | boolean;
  onRenamed: () => void;
  onContextMenu: (e: React.MouseEvent, thread: ThreadSummary) => void;
};

const ThreadRow = memo(function ThreadRow({
  thread,
  active,
  onSelect,
  onDelete,
  onRename,
  onRenamed,
  onContextMenu,
}: ThreadRowProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);

  const commitRenameRef = useRef(false);
  async function commitRename() {
    if (commitRenameRef.current) return; // 二重実行防止（onBlur + Enter）
    const trimmed = draft.trim();
    if (!trimmed || trimmed === thread.title) {
      setEditing(false);
      setDraft(thread.title);
      return;
    }
    commitRenameRef.current = true;
    const ok = await onRename(thread.id, trimmed);
    commitRenameRef.current = false;
    if (ok) {
      setEditing(false);
      onRenamed();
    }
    // 失敗時は編集状態を保持し、ユーザーが再試行できるようにする
  }

  if (editing) {
    return (
      <li className="px-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRename();
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(thread.title);
            }
          }}
          className="w-full rounded-xl bg-muted px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-foreground/20"
        />
      </li>
    );
  }

  return (
    <li
      className="group flex items-center gap-1 rounded-xl px-1"
      onContextMenu={(e) => onContextMenu(e, thread)}
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        onDoubleClick={() => {
          setDraft(thread.title);
          setEditing(true);
        }}
        className={`flex-1 truncate rounded px-2 py-1.5 text-left text-sm transition-all duration-150 hover:bg-muted/70 ${
          active ? "bg-muted font-medium ring-1 ring-border" : ""
        }`}
        title={thread.title}
      >
        {thread.title}
      </button>
      <button
        type="button"
        onClick={() => onDelete(thread.id)}
        aria-label={t("common.delete")}
        className="hidden shrink-0 rounded px-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-red-500/10 hover:text-red-500 group-hover:block"
      >
        ×
      </button>
    </li>
  );
});
