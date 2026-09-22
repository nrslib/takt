import { AppHeader } from '../components/AppHeader';
import { DemoControls } from '../components/DemoControls';
import { DiscardChangesDialog } from '../components/DiscardChangesDialog';
import { HelpDialog } from '../components/HelpDialog';
import { InquiryDetail } from '../components/InquiryDetail';
import { InquiryList } from '../components/InquiryList';
import { ReplyEditor } from '../components/ReplyEditor';
import { findSelected, hasUnsavedChanges } from './inquiryDeskMachine';
import { useInquiryDesk } from './useInquiryDesk';

/** 画面：状態と操作を useInquiryDesk から受け、表示部品へ値と通知先を配る */
export function InquiryDeskScreen() {
  const { state, handlers, dialogReturnFocusRef } = useInquiryDesk();
  const selected = findSelected(state);
  const unsaved = hasUnsavedChanges(state);
  const { phase } = state;
  const saving = phase.kind === 'saving';
  const switchTarget =
    phase.kind === 'confirmingSwitch' ? state.inquiries.find((inquiry) => inquiry.id === phase.targetId) : undefined;

  return (
    <div className="app">
      <AppHeader onOpenHelp={handlers.openHelp} />
      <main className="layout">
        <InquiryList
          inquiries={state.inquiries}
          selectedId={state.selectedId}
          selectedHasUnsavedChanges={unsaved}
          switchLocked={saving}
          rejectionMessage={state.rejection?.area === 'list' ? state.rejection.message : null}
          onSelect={handlers.selectInquiry}
        />
        <div className="detail-pane">
          <InquiryDetail inquiry={selected} />
          <ReplyEditor
            subject={selected.subject}
            draft={state.draft}
            savedAt={selected.replyUpdatedAt}
            saving={saving}
            hasUnsavedChanges={unsaved}
            outcome={state.lastOutcome}
            rejectionMessage={state.rejection?.area === 'editor' ? state.rejection.message : null}
            onDraftChange={handlers.changeDraft}
            onSave={handlers.requestSave}
            onRevert={handlers.revert}
            onOpenHelp={handlers.openHelp}
          />
        </div>
      </main>
      <DemoControls
        failNextSave={state.failNextSave}
        acceptedSaveCount={state.acceptedSaveCount}
        onFailNextSaveChange={handlers.setFailNextSave}
      />

      <HelpDialog open={state.helpOpen} onClose={handlers.closeHelp} returnFocusRef={dialogReturnFocusRef} />
      <DiscardChangesDialog
        open={switchTarget !== undefined}
        currentSubject={selected.subject}
        targetSubject={switchTarget?.subject ?? ''}
        onDiscard={handlers.confirmSwitch}
        onCancel={handlers.cancelSwitch}
        returnFocusRef={dialogReturnFocusRef}
      />
    </div>
  );
}
