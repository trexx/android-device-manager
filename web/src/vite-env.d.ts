/// <reference types="vite/client" />

// The File System Access API's save dialog is not in lib.dom yet (only the
// origin-private parts are). Optional: it exists in Chromium only.
interface Window {
  showSaveFilePicker?(options?: { suggestedName?: string }): Promise<FileSystemFileHandle>;
}
