import React from 'react';
import type { ExtraProps } from 'streamdown';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { getExternalFaviconUrl, isAppLinkUrl, isExternalHttpUrl, isLoopbackHttpUrl } from '@/lib/url';
import { parseSessionLink } from '@/lib/sessionLinks';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { parseAgentHref, parseAttachmentHref, parseSkillHref, INLINE_REFERENCE_CHIP_CLASS, INTERACTIVE_REFERENCE_CHIP_CLASS, buildAgentMentionUrl } from '@/lib/messages/inlineMessageLinks';
import { openAppLinkWithConfirmation } from '../appLinkConfirmation';
import { useOpenChatLink } from '../useOpenChatLink';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { activateMarkdownFile, resolveMarkdownFile, useOpenMarkdownFile } from './markdownFileReferences';
import { MarkdownMediaLinkContext, useMarkdownMedia } from './markdown-media-context';
import { openMarkdownDocumentLink } from '@/components/views/files/previews/useMarkdownLocalAssets';

function ownOrigins(): string[] {
  try {
    return [window.location.origin, new URL(getRuntimeApiBaseUrl() || window.location.href, window.location.href).origin];
  } catch {
    return [window.location.origin];
  }
}

function useConfirmedInlineFile(raw: string): string | null {
  const { directory, fileReferences, confirmFile } = useMarkdownPresentation();
  const runtimeKey = getRuntimeKey();
  const [confirmed, setConfirmed] = React.useState<{ raw: string; directory: string; runtimeKey: string; path: string } | null>(null);
  React.useEffect(() => {
    if (!fileReferences) return;
    let active = true;
    void confirmFile(raw).then((path) => {
      if (active && runtimeKey === getRuntimeKey()) setConfirmed(path ? { raw, directory, runtimeKey, path } : null);
    });
    return () => { active = false; };
  }, [raw, directory, fileReferences, runtimeKey, confirmFile]);
  return fileReferences && confirmed?.raw === raw && confirmed.directory === directory && confirmed.runtimeKey === runtimeKey ? confirmed.path : null;
}

export function MarkdownInlineCode({ children, node: _node, ...props }: React.ComponentProps<'code'> & ExtraProps) {
  const raw = _node?.children.map((child) => child.type === 'text' ? child.value : '').join('') ?? '';
  const path = useConfirmedInlineFile(raw);
  const open = useOpenMarkdownFile();
  const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (path) activateMarkdownFile(event, (external) => { void open(raw, path, external); });
  };
  return (
    <code
      {...props}
      dir="ltr"
      data-streamdown="inline-code"
      data-openchamber-file-link={path ? 'true' : undefined}
      data-openchamber-file-ref={path ? raw : undefined}
      data-openchamber-file-path={path ?? undefined}
      role={path ? 'button' : undefined}
      tabIndex={path ? 0 : undefined}
      onClick={path ? activate : undefined}
      onKeyDown={path ? activate : undefined}
    >
      {children}
    </code>
  );
}

export function MarkdownLink(props: React.ComponentProps<'a'> & ExtraProps) {
  const { purpose } = useMarkdownPresentation();
  if (purpose) {
    const { node: _node, children, ...rest } = props;
    return (
      <a {...rest}>
        <MarkdownMediaLinkContext.Provider value={true}>{children}</MarkdownMediaLinkContext.Provider>
      </a>
    );
  }
  return <ScreenMarkdownLink {...props} />;
}

function ScreenMarkdownLink({ href = '', children: originalChildren, node: _node, ...props }: React.ComponentProps<'a'> & ExtraProps) {
  const children = <MarkdownMediaLinkContext.Provider value={true}>{originalChildren}</MarkdownMediaLinkContext.Provider>;
  const presentation = useMarkdownPresentation();
  const { directory } = presentation;
  const { t } = useI18n();
  const openChatLink = useOpenChatLink(directory);
  const openFile = useOpenMarkdownFile();
  const media = useMarkdownMedia();
  const path = useConfirmedInlineFile(href);
  const skill = parseSkillHref(href);
  const agent = parseAgentHref(href);
  const attachment = parseAttachmentHref(href);
  const session = parseSessionLink(href, ownOrigins());
  const app = isAppLinkUrl(href);
  const file = presentation.fileNavigation && resolveMarkdownFile(href, directory);
  const external = isExternalHttpUrl(href);
  const favicon = external ? getExternalFaviconUrl(href) : null;
  const showPreview = isLoopbackHttpUrl(href) && directory && !(isDesktopShell() && useUIStore.getState().openLinksInBrowserPanel);
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (media?.documentAssets && openMarkdownDocumentLink(event, media.documentAssets)) return;
    if (session) {
      if (isVSCodeRuntime()) { event.preventDefault(); return; }
      if (!external || !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
        event.preventDefault();
        void openSessionLink(session.sessionId, session.messageId);
        return;
      }
    }
    if (app) {
      event.preventDefault();
      event.stopPropagation();
      void openAppLinkWithConfirmation(href);
      return;
    }
    if (skill) return;
    if (file) {
      activateMarkdownFile(event, (external) => { void openFile(href, path ?? undefined, external); });
      return;
    }
    if (external && !presentation.disableLinkSafety && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
      event.preventDefault();
      event.stopPropagation();
      openChatLink(href);
    }
  };
  if (attachment) {
    return (
      <span
        className={attachment.openable ? INTERACTIVE_REFERENCE_CHIP_CLASS : INLINE_REFERENCE_CHIP_CLASS}
        data-attachment-citation={attachment.iconId}
        data-attachment-open={attachment.openable ? attachment.filename : undefined}
        role={attachment.openable ? 'button' : undefined}
        tabIndex={attachment.openable ? 0 : undefined}
        title={attachment.filename}
      >
        <svg className="size-[1em] shrink-0" aria-hidden="true"><use href={`#${attachment.iconId}`} /></svg>
        {attachment.filename}
      </span>
    );
  }
  if (agent) {
    return (
      <a data-openchamber-agent-mention="true" className="text-primary hover:underline" href={buildAgentMentionUrl(agent)} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <>
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={skill ? INTERACTIVE_REFERENCE_CHIP_CLASS : props.className}
        data-skill-name={skill ?? undefined}
        title={skill ? `$${skill}` : props.title}
        data-openchamber-file-link={path ? 'true' : undefined}
        onClick={handleClick}
        onAuxClick={(event) => {
          if (!app) return;
          event.preventDefault();
          if (event.button === 1) void openAppLinkWithConfirmation(href);
        }}
        onDragStart={app ? (event) => event.preventDefault() : undefined}
      >
        {skill && <Icon name="book-open" className="size-[1em]" />}
        {!skill && favicon && (
          <img src={favicon} alt="" data-message-image-export-exclude="true" data-export-ignore className="inline size-[1em] me-1" />
        )}
        {skill ?? children}
      </a>
      {showPreview && (
        <Button
          variant="ghost"
          size="xs"
          data-export-ignore
          title={t('terminalView.preview.openTitle')}
          onClick={() => useUIStore.getState().openContextPreview(directory, href)}
        >
          <Icon name="external-link" className="size-3" />
        </Button>
      )}
    </>
  );
}
