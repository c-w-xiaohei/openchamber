import React from 'react';
import type { ToolPopupContent } from '../message/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { MarkdownMediaOwner, MediaContext, type MarkdownDocumentAssets } from './markdown-media-context';

export type { MarkdownDocumentAssets } from './markdown-media-context';

export function MarkdownMediaProvider({
  content,
  mode,
  sessionId,
  messageId,
  directory,
  settled,
  documentAssets,
  onShowPopup,
  children,
}: {
  content: string;
  mode: 'assistant' | 'local' | 'document';
  sessionId?: string;
  messageId?: string;
  directory: string;
  settled: boolean;
  documentAssets?: MarkdownDocumentAssets;
  onShowPopup?: (content: ToolPopupContent) => void;
  children: React.ReactNode;
}) {
  const [transportRevision, advanceTransport] = React.useReducer((revision: number) => revision + 1, 0);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => advanceTransport()), []);
  const runtimeKey = getRuntimeKey();
  const filePath = documentAssets?.filePath;
  const workspaceRoot = documentAssets?.workspaceRoot;
  // Color scheme and link callbacks can change without revoking loaded assets.
  const owner = React.useMemo(() => {
    // Runtime/content are ownership even when the paths and IDs are unchanged.
    void content;
    void runtimeKey;
    void transportRevision;
    return new MarkdownMediaOwner({
      mode,
      directory,
      sessionId,
      messageId,
      documentAssets: filePath ? { filePath, workspaceRoot: workspaceRoot ?? null } : undefined,
    });
  }, [content, mode, directory, sessionId, messageId, runtimeKey, transportRevision, filePath, workspaceRoot]);
  React.useEffect(() => {
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => owner.dispose());
    // StrictMode replays effects with the same memoized owner. Defer final
    // disposal one microtask so that replay can reclaim it, while endpoint
    // changes still abort synchronously before credentials are replaced.
    const lease = owner.lease = Symbol();
    return () => {
      unsubscribe();
      queueMicrotask(() => {
        if (owner.lease === lease) owner.dispose();
      });
    };
  }, [owner]);
  const value = React.useMemo(
    () => ({ owner, mode, settled, documentAssets, onShowPopup }),
    [owner, mode, settled, documentAssets, onShowPopup],
  );
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}
