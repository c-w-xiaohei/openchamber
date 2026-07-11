import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';

export const useFileNavigation = () => {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

    return React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) return;

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = mobileActions || !isFilePathWithinDirectory(absolutePath, currentDirectory)
            ? currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath)
            : getDirectoryForFilePath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
        } else {
            uiStore.openContextFile(contextDirectory, absolutePath);
        }
        mobileActions?.openFiles();
    }, [currentDirectory, mobileActions, runtime]);
};
