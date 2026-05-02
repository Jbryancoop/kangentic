// Single shared persistent partition for the embedded browser pane.
// All tasks across all projects use this one cookie jar. Per-project and
// per-task variants were considered and deferred. The Clear Browser Data
// action in Settings -> Browser covers the storage and privacy concern
// without the migration cost.
//
// Imported by both the renderer (`<webview partition>`) and the main process
// (`session.fromPartition` in the clear-storage IPC handler) so the two stay
// in lockstep automatically.
export const BROWSER_PARTITION = 'persist:kangentic-browser';
