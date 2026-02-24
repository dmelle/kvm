import { useCallback, useEffect, useRef, useState } from "react";
import {
  LuDownload,
  LuHardDriveUpload,
  LuPlug,
  LuTrash2,
  LuUnplug,
  LuUpload,
} from "react-icons/lu";

import { useUiStore } from "@hooks/stores";
import { useJsonRpc } from "@hooks/useJsonRpc";
import { JsonRpcResponse } from "@hooks/useJsonRpc";
import SidebarHeader from "@components/SidebarHeader";
import { Button } from "@components/Button";
import notifications from "@/notifications";
import { cx } from "@/cva.config";

interface FileTransferEntry {
  name: string;
  size: number;
}

interface FileTransferStateResponse {
  state: "no_drive" | "locally_mounted" | "connected_to_target";
  files?: FileTransferEntry[];
  size?: number;
  used?: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function FileTransferSidebar() {
  const { setSidebarView } = useUiStore();
  const { send } = useJsonRpc();

  const [state, setState] = useState<FileTransferStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sizeMB, setSizeMB] = useState(512);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshState = useCallback(() => {
    send("fileTransferGetState", {}, (resp: JsonRpcResponse) => {
      if ("error" in resp) {
        console.error("Failed to get file transfer state", resp.error);
        return;
      }
      setState(resp.result as FileTransferStateResponse);
    });
  }, [send]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const handleCreateDrive = useCallback(() => {
    setLoading(true);
    send("fileTransferCreateDrive", { sizeMB }, (resp: JsonRpcResponse) => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`Failed to create drive: ${resp.error.data || resp.error.message}`);
        return;
      }
      setState(resp.result as FileTransferStateResponse);
      notifications.success("File transfer drive created");
    });
  }, [send, sizeMB]);

  const handleDeleteDrive = useCallback(() => {
    if (!confirm("Delete the file transfer drive? All files will be lost.")) return;
    setLoading(true);
    send("fileTransferDeleteDrive", {}, (resp: JsonRpcResponse) => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`Failed to delete drive: ${resp.error.data || resp.error.message}`);
        return;
      }
      setState({ state: "no_drive" });
      notifications.success("File transfer drive deleted");
    });
  }, [send]);

  const handleConnect = useCallback(() => {
    setLoading(true);
    send("fileTransferConnectToTarget", {}, (resp: JsonRpcResponse) => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`Failed to connect: ${resp.error.data || resp.error.message}`);
        return;
      }
      refreshState();
      notifications.success("Drive connected to target");
    });
  }, [send, refreshState]);

  const handleDisconnect = useCallback(() => {
    setLoading(true);
    send("fileTransferDisconnectFromTarget", {}, (resp: JsonRpcResponse) => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`Failed to disconnect: ${resp.error.data || resp.error.message}`);
        return;
      }
      refreshState();
      notifications.success("Drive disconnected from target");
    });
  }, [send, refreshState]);

  const handleDeleteFile = useCallback(
    (filename: string) => {
      send("fileTransferDeleteFile", { filename }, (resp: JsonRpcResponse) => {
        if ("error" in resp) {
          notifications.error(`Failed to delete: ${resp.error.data || resp.error.message}`);
          return;
        }
        refreshState();
      });
    },
    [send, refreshState],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const resp = await fetch("/file-transfer/upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });

        if (!resp.ok) {
          const data = await resp.json();
          notifications.error(`Upload failed: ${data.error || "Unknown error"}`);
          return;
        }

        notifications.success(`Uploaded ${file.name}`);
        refreshState();
      } catch {
        notifications.error("Upload failed");
      }
    },
    [refreshState],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files?.length) return;
      for (const file of Array.from(files)) {
        handleUpload(file);
      }
      e.target.value = "";
    },
    [handleUpload],
  );

  const handleDownload = useCallback((filename: string) => {
    window.open(`/file-transfer/download/${encodeURIComponent(filename)}`, "_blank");
  }, []);

  const driveState = state?.state ?? "no_drive";

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900">
      <SidebarHeader title="File Transfer" setSidebarView={setSidebarView} />

      <div className="flex-1 overflow-y-auto p-4">
        {driveState === "no_drive" && (
          <NoDriveView
            sizeMB={sizeMB}
            setSizeMB={setSizeMB}
            loading={loading}
            onCreateDrive={handleCreateDrive}
          />
        )}

        {driveState === "locally_mounted" && (
          <LocallyMountedView
            state={state!}
            loading={loading}
            fileInputRef={fileInputRef}
            onConnect={handleConnect}
            onDeleteDrive={handleDeleteDrive}
            onDeleteFile={handleDeleteFile}
            onDownload={handleDownload}
            onFileSelect={handleFileSelect}
            onUpload={handleUpload}
          />
        )}

        {driveState === "connected_to_target" && (
          <ConnectedToTargetView
            state={state!}
            loading={loading}
            onDisconnect={handleDisconnect}
            onDeleteDrive={handleDeleteDrive}
          />
        )}
      </div>
    </div>
  );
}

function NoDriveView({
  sizeMB,
  setSizeMB,
  loading,
  onCreateDrive,
}: {
  sizeMB: number;
  setSizeMB: (size: number) => void;
  loading: boolean;
  onCreateDrive: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Create a virtual USB drive that can be used to transfer files to and from the target
        machine.
      </p>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
          Drive Size
        </label>
        <select
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          value={sizeMB}
          onChange={e => setSizeMB(Number(e.target.value))}
        >
          <option value={64}>64 MB</option>
          <option value={128}>128 MB</option>
          <option value={256}>256 MB</option>
          <option value={512}>512 MB</option>
          <option value={1024}>1 GB</option>
          <option value={2048}>2 GB</option>
        </select>
      </div>
      <Button
        size="SM"
        theme="primary"
        fullWidth
        text="Create Drive"
        LeadingIcon={LuHardDriveUpload}
        loading={loading}
        onClick={onCreateDrive}
      />
    </div>
  );
}

function LocallyMountedView({
  state,
  loading,
  fileInputRef,
  onConnect,
  onDeleteDrive,
  onDeleteFile,
  onDownload,
  onFileSelect,
  onUpload,
}: {
  state: FileTransferStateResponse;
  loading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onConnect: () => void;
  onDeleteDrive: () => void;
  onDeleteFile: (filename: string) => void;
  onDownload: (filename: string) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onUpload: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const files = state.files ?? [];

  return (
    <div className="space-y-4">
      {/* Storage bar */}
      {state.size && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>{formatBytes(state.used ?? 0)} used</span>
            <span>{formatBytes(state.size)} total</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-blue-500"
              style={{ width: `${Math.min(100, ((state.used ?? 0) / state.size) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Upload zone */}
      <div
        className={cx(
          "rounded-lg border-2 border-dashed p-4 text-center transition-colors",
          dragOver
            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
            : "border-slate-300 dark:border-slate-600",
        )}
        onDragOver={e => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          const droppedFiles = e.dataTransfer.files;
          for (const file of Array.from(droppedFiles)) {
            onUpload(file);
          }
        }}
      >
        <LuUpload className="mx-auto mb-2 h-6 w-6 text-slate-400" />
        <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
          Drag files here or click to browse
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onFileSelect}
        />
        <Button
          size="XS"
          theme="light"
          text="Browse Files"
          onClick={() => fileInputRef.current?.click()}
        />
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
            Files ({files.length})
          </h3>
          <div className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
            {files.map(file => (
              <div
                key={file.name}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-slate-900 dark:text-white">{file.name}</p>
                  <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
                </div>
                <div className="ml-2 flex gap-1">
                  <button
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600 dark:hover:bg-slate-800"
                    onClick={() => onDownload(file.name)}
                    title="Download"
                  >
                    <LuDownload className="h-4 w-4" />
                  </button>
                  <button
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
                    onClick={() => onDeleteFile(file.name)}
                    title="Delete"
                  >
                    <LuTrash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {files.length === 0 && (
        <p className="text-center text-sm text-slate-400">No files on drive</p>
      )}

      {/* Actions */}
      <div className="space-y-2">
        <Button
          size="SM"
          theme="primary"
          fullWidth
          text="Connect to Target"
          LeadingIcon={LuPlug}
          loading={loading}
          onClick={onConnect}
        />
        <Button
          size="SM"
          theme="danger"
          fullWidth
          text="Delete Drive"
          LeadingIcon={LuTrash2}
          loading={loading}
          onClick={onDeleteDrive}
        />
      </div>
    </div>
  );
}

function ConnectedToTargetView({
  state,
  loading,
  onDisconnect,
  onDeleteDrive,
}: {
  state: FileTransferStateResponse;
  loading: boolean;
  onDisconnect: () => void;
  onDeleteDrive: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
        <div className="flex items-center gap-2">
          <LuPlug className="h-5 w-5 text-green-600 dark:text-green-400" />
          <p className="text-sm font-medium text-green-800 dark:text-green-200">
            Drive connected to target machine
          </p>
        </div>
        {state.size && (
          <p className="mt-1 text-xs text-green-600 dark:text-green-400">
            Drive size: {formatBytes(state.size)}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Safely eject the drive on the target machine before disconnecting.
        </p>
      </div>

      <div className="space-y-2">
        <Button
          size="SM"
          theme="primary"
          fullWidth
          text="Disconnect from Target"
          LeadingIcon={LuUnplug}
          loading={loading}
          onClick={onDisconnect}
        />
        <Button
          size="SM"
          theme="danger"
          fullWidth
          text="Delete Drive"
          LeadingIcon={LuTrash2}
          loading={loading}
          onClick={onDeleteDrive}
        />
      </div>
    </div>
  );
}
