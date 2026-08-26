export function snapshotExecutionSettings(settings) {
  return { ...settings };
}

export function buildExecutionSettingsRequest(settings) {
  const worktree = settings.worktreeMode === 'none'
    ? false
    : settings.worktreeMode === 'custom'
      ? settings.worktreePath
      : true;
  return {
    worktree,
    ...(settings.branch === '' ? {} : { branch: settings.branch }),
    ...(settings.baseBranch === '' ? {} : { baseBranch: settings.baseBranch }),
    autoPr: settings.autoPr,
    draftPr: settings.draftPr,
  };
}

export function isWorkflowCatalogReady(selectedProjectId, catalogProjectId, categories) {
  return selectedProjectId !== ''
    && selectedProjectId === catalogProjectId
    && Array.isArray(categories)
    && categories.some((category) =>
      Array.isArray(category.workflows) && category.workflows.length > 0);
}

export function isCurrentWorkflowRequest(request, currentRequestId, selectedProjectId) {
  return request.requestId === currentRequestId && request.projectId === selectedProjectId;
}

export function sameRunSelection(left, right) {
  return left !== null
    && right !== null
    && left.projectId === right.projectId
    && left.slug === right.slug;
}

export function isCurrentRunRequest(request, currentGeneration, currentSelection, currentSnapshotRevision) {
  return request.generation === currentGeneration
    && request.snapshotRevision === currentSnapshotRevision
    && sameRunSelection(request.selection, currentSelection);
}

export function projectSelectionForRefresh(preferredProjectId, currentProjectId) {
  return preferredProjectId === currentProjectId ? preferredProjectId : currentProjectId;
}

export function captureRunDetailViewState(runDetail) {
  return {
    scrollTop: runDetail.scrollTop,
    openReportFilenames: [...runDetail.querySelectorAll('details.report[data-report-filename]')]
      .filter((detail) => detail.open)
      .map((detail) => detail.dataset.reportFilename)
      .filter((filename) => filename !== undefined),
  };
}

export function restoreRunDetailViewState(runDetail, state) {
  const openReportFilenames = new Set(state.openReportFilenames);
  for (const detail of runDetail.querySelectorAll('details.report[data-report-filename]')) {
    detail.open = openReportFilenames.has(detail.dataset.reportFilename);
  }
  runDetail.scrollTop = state.scrollTop;
}

export function shouldCloseExecutionContext(event, contextElement, dialogElement) {
  const eventPath = typeof event.composedPath === 'function'
    ? event.composedPath()
    : [event.target];
  if (eventPath.includes(contextElement)) return false;
  // Keep the context open for the click that closes the directory dialog too:
  // the dialog's close handler runs before this document-level click listener.
  if (dialogElement !== undefined && eventPath.includes(dialogElement)) return false;
  if (typeof Node !== 'undefined' && event.target instanceof Node && contextElement.contains(event.target)) {
    return false;
  }
  return true;
}

export function createDirectoryRequestTracker() {
  let dialogSessionId = 0;
  let requestId = 0;
  let dialogOpen = false;
  let activeOperation = null;

  function isCurrent(token) {
    return token !== null
      && dialogOpen
      && token.dialogSessionId === dialogSessionId
      && token.requestId === requestId;
  }

  function isCurrentOperation(kind) {
    return activeOperation?.kind === kind
      && isCurrent(activeOperation.token);
  }

  function hasPendingOperation() {
    return activeOperation?.pending === true
      && isCurrent(activeOperation.token);
  }

  function finishRequest(token) {
    if (!isCurrent(token) || activeOperation?.pending === true) return false;
    activeOperation = null;
    return true;
  }

  function finishPendingOperation(token) {
    if (!hasPendingOperation() || activeOperation?.token !== token) return false;
    activeOperation = null;
    return true;
  }

  return {
    openDialog() {
      dialogSessionId += 1;
      requestId += 1;
      dialogOpen = true;
      activeOperation = null;
    },
    closeDialog() {
      if (!dialogOpen) {
        activeOperation = null;
        return;
      }
      dialogSessionId += 1;
      requestId += 1;
      dialogOpen = false;
      activeOperation = null;
    },
    invalidateRequest() {
      requestId += 1;
      activeOperation = null;
    },
    beginRequest(kind = 'browse') {
      if (!dialogOpen || activeOperation?.pending === true) return null;
      requestId += 1;
      const token = { dialogSessionId, requestId };
      activeOperation = { kind, pending: false, token };
      return token;
    },
    beginPendingOperation(kind) {
      if (!dialogOpen || activeOperation?.pending === true) return null;
      requestId += 1;
      const token = { dialogSessionId, requestId };
      activeOperation = { kind, pending: true, token };
      return token;
    },
    isCurrent,
    isCurrentOperation,
    hasPendingOperation,
    finishRequest,
    finishPendingOperation,
  };
}
