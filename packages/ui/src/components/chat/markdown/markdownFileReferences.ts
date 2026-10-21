import { BLOCK_PATH_TOKEN_RE, localPathFromFileUrl, normalizeReferencePath, parseFileReference } from '../fileReferenceParser';
import { fileReferenceExists, findUniqueFileByName } from '../fileReferenceStat';
import { isAbsoluteFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import type { ConfirmedCodePath } from './streamdownCode';
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { HighlightResultCache } from './highlightResultCache';
import { hasTextSelectionInside } from '@/lib/textSelection';

/** A selection-ending click is consumed without navigating, as before migration. */
export function activateMarkdownFile(event: React.MouseEvent | React.KeyboardEvent, open: (external: boolean) => void): void {
  if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  if (!('key' in event) && hasTextSelectionInside(event.currentTarget.closest('[data-markdown-content]'))) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  open(isMac ? event.metaKey : event.ctrlKey);
}

// Only lexical matches are cached globally. Resolution and existence remain
// directory/runtime-bound and continue through the caller's confirmation path.
const codePathCandidates = new HighlightResultCache<Array<{ raw: string; start: number }>>({ maxEntries: 64, maxBytes: 1024 * 1024 });

export function useOpenMarkdownFile() {
  const { directory } = useMarkdownPresentation();
  const apis = React.useContext(RuntimeAPIContext);
  const editor = apis?.editor;
  const isVSCode = apis?.runtime.isVSCode;
  return React.useCallback(async (raw: string, path?: string, external = false) => {
    const reference = resolveMarkdownFile(raw, directory);
    if (!reference) return;
    const target = path ?? reference.resolvedPath;
    if (external && isDesktopLocalOriginActive() && await openDesktopPath(target)) return;
    if (isVSCode && editor) { void editor.openFile(target, reference.line, reference.column); return; }
    const ui = useUIStore.getState();
    if (reference.line) ui.openContextFileAtLine(directory, target, reference.line, reference.column ?? 1);
    else ui.openContextFile(directory, target);
  }, [directory, editor, isVSCode]);
}

export function resolveMarkdownFile(raw: string, directory: string) {
  // Most code tokens are paths, not URLs. Avoid constructing and throwing a URL
  // for every ordinary identifier/path in a highlighted fence.
  const reference = parseFileReference(/^\s*file:/i.test(raw) ? localPathFromFileUrl(raw) ?? raw : raw);
  if (!reference || !directory || reference.path.includes('://') || /[<>]/.test(reference.path)) return null;
  const name = reference.path.split(/[\\/]/).pop() ?? '';
  if (!/\.[\w-]{1,16}$/.test(name) && !['dockerfile', 'makefile', 'readme', 'license'].includes(name.toLowerCase()) && !name.startsWith('.')) return null;
  const path = isAbsoluteFilePath(reference.path) ? normalizeReferencePath(reference.path) : toAbsoluteFilePath(directory, reference.path);
  return path ? { ...reference, resolvedPath: path } : null;
}

export async function confirmMarkdownFile(raw: string, directory: string): Promise<string | null> {
  const reference = resolveMarkdownFile(raw, directory);
  if (!reference) return null;
  if (!isFilePathWithinDirectory(reference.resolvedPath, directory)) return reference.resolvedPath;
  if (await fileReferenceExists(reference.resolvedPath, directory)) return reference.resolvedPath;
  return !/[\\/]/.test(reference.path) ? findUniqueFileByName(reference.path, directory) : null;
}

export async function confirmCodePaths(code: string, directory: string, limit: number, confirm: (raw: string) => Promise<string | null> = (raw) => confirmMarkdownFile(raw, directory)): Promise<ConfirmedCodePath[]> {
  if (code.length > 200_000) return [];
  let matches = codePathCandidates.get(code);
  if (!matches) {
    matches = Array.from(code.matchAll(BLOCK_PATH_TOKEN_RE), (match) => ({ raw: match[0], start: match.index }));
    const bytes = code.length * 2 + matches.reduce((sum, match) => sum + match.raw.length * 2 + 32, 0);
    if (bytes <= 1024 * 1024) codePathCandidates.set(code, matches, bytes);
  }
  const candidates = matches.filter((match) => resolveMarkdownFile(match.raw, directory)).slice(0, limit);
  const confirmed = await Promise.all(candidates.map(async (match) => {
    const path = await confirm(match.raw);
    return path ? { start: match.start, end: match.start + match.raw.length, raw: match.raw, path } : null;
  }));
  return confirmed.filter((value): value is ConfirmedCodePath => value !== null);
}
