import { isBlankReply, type Inquiry } from '../domain/inquiry';

/**
 * 問い合わせ返信画面の状態機械。
 * 現在の状態と操作（event）から、受理・拒否と次の状態を決める純粋な関数だけを置く。
 * 保存通信などの副作用は useInquiryDesk のハンドラが開始する。
 */

export type DeskPhase =
  | { kind: 'editing' }
  | { kind: 'confirmingSwitch'; targetId: string }
  | { kind: 'saving'; requestId: number; inquiryId: string; reply: string; simulateFailure: boolean };

/** 選択中の問い合わせに対する直近の保存結果 */
export type SaveOutcome =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'failed'; message: string }
  | { kind: 'saved' };

/** 受け付けなかった操作の理由。操作した場所の近くに表示する */
export type Rejection = { area: 'list' | 'editor'; message: string } | null;

export type DeskState = {
  inquiries: Inquiry[];
  selectedId: string;
  /** 選択中の問い合わせに対する編集中の返信。切替時に必ず作り直す */
  draft: string;
  phase: DeskPhase;
  helpOpen: boolean;
  lastOutcome: SaveOutcome;
  rejection: Rejection;
  failNextSave: boolean;
  /** 受け付けた保存処理の累計（実演用） */
  acceptedSaveCount: number;
};

export type DeskEvent =
  | { type: 'inquirySelected'; inquiryId: string }
  | { type: 'switchConfirmed' }
  | { type: 'switchCancelled' }
  | { type: 'draftChanged'; text: string }
  | { type: 'saveRequested' }
  | { type: 'saveSucceeded'; requestId: number; inquiry: Inquiry }
  | { type: 'saveFailed'; requestId: number; message: string }
  | { type: 'revertRequested' }
  | { type: 'helpOpened' }
  | { type: 'helpClosed' }
  | { type: 'failNextSaveChanged'; enabled: boolean };

export function createInitialState(inquiries: Inquiry[]): DeskState {
  const first = inquiries[0];
  if (first === undefined) {
    throw new Error('問い合わせが1件もありません。');
  }
  return {
    inquiries,
    selectedId: first.id,
    draft: first.reply,
    phase: { kind: 'editing' },
    helpOpen: false,
    lastOutcome: { kind: 'none' },
    rejection: null,
    failNextSave: false,
    acceptedSaveCount: 0,
  };
}

export function findSelected(state: DeskState): Inquiry {
  const selected = state.inquiries.find((inquiry) => inquiry.id === state.selectedId);
  if (selected === undefined) {
    throw new Error(`選択中の問い合わせ ${state.selectedId} が見つかりません。`);
  }
  return selected;
}

export function hasUnsavedChanges(state: DeskState): boolean {
  return state.draft !== findSelected(state).reply;
}

const MESSAGES = {
  switchWhileSaving: '保存中のため、他の問い合わせには切り替えられません。保存が終わるまでお待ちください。',
  saveWhileSaving: '保存中です。同じ保存は一度だけ行うため、この操作は受け付けませんでした。',
  revertWhileSaving: '保存中のため、保存済みの内容へ戻せません。保存が終わるまでお待ちください。',
  dialogOpen: 'ダイアログを閉じてから操作してください。',
} as const;

function reject(state: DeskState, area: 'list' | 'editor', message: string): DeskState {
  return { ...state, rejection: { area, message } };
}

/** 選択を切り替え、下書きと保存結果を新しい対象のものに作り直す */
function switchTo(state: DeskState, inquiryId: string): DeskState {
  const target = state.inquiries.find((inquiry) => inquiry.id === inquiryId);
  if (target === undefined) {
    return state;
  }
  return {
    ...state,
    selectedId: target.id,
    draft: target.reply,
    phase: { kind: 'editing' },
    lastOutcome: { kind: 'none' },
    rejection: null,
  };
}

function isModalOpen(state: DeskState): boolean {
  return state.helpOpen || state.phase.kind === 'confirmingSwitch';
}

export function deskReducer(state: DeskState, event: DeskEvent): DeskState {
  switch (event.type) {
    case 'inquirySelected': {
      if (isModalOpen(state)) {
        return reject(state, 'list', MESSAGES.dialogOpen);
      }
      if (event.inquiryId === state.selectedId) {
        return state;
      }
      if (state.phase.kind === 'saving') {
        return reject(state, 'list', MESSAGES.switchWhileSaving);
      }
      if (hasUnsavedChanges(state)) {
        return { ...state, phase: { kind: 'confirmingSwitch', targetId: event.inquiryId }, rejection: null };
      }
      return switchTo(state, event.inquiryId);
    }

    case 'switchConfirmed': {
      if (state.phase.kind !== 'confirmingSwitch') {
        return state;
      }
      return switchTo(state, state.phase.targetId);
    }

    case 'switchCancelled': {
      if (state.phase.kind !== 'confirmingSwitch') {
        return state;
      }
      return { ...state, phase: { kind: 'editing' }, rejection: null };
    }

    case 'draftChanged': {
      // 保存中・確認中は、判断の前提となる入力を変えさせない
      if (state.phase.kind !== 'editing' || state.helpOpen) {
        return state;
      }
      return {
        ...state,
        draft: event.text,
        lastOutcome: state.lastOutcome.kind === 'invalid' ? { kind: 'none' } : state.lastOutcome,
        rejection: null,
      };
    }

    case 'saveRequested': {
      if (isModalOpen(state)) {
        return reject(state, 'editor', MESSAGES.dialogOpen);
      }
      if (state.phase.kind === 'saving') {
        return reject(state, 'editor', MESSAGES.saveWhileSaving);
      }
      if (isBlankReply(state.draft)) {
        return { ...state, lastOutcome: { kind: 'invalid' }, rejection: null };
      }
      const requestId = state.acceptedSaveCount + 1;
      return {
        ...state,
        phase: {
          kind: 'saving',
          requestId,
          inquiryId: state.selectedId,
          reply: state.draft,
          simulateFailure: state.failNextSave,
        },
        failNextSave: false,
        acceptedSaveCount: requestId,
        rejection: null,
      };
    }

    case 'saveSucceeded': {
      if (state.phase.kind !== 'saving' || state.phase.requestId !== event.requestId) {
        return state;
      }
      const saved = event.inquiry;
      return {
        ...state,
        inquiries: state.inquiries.map((inquiry) => (inquiry.id === saved.id ? saved : inquiry)),
        phase: { kind: 'editing' },
        lastOutcome: { kind: 'saved' },
        rejection: null,
      };
    }

    case 'saveFailed': {
      if (state.phase.kind !== 'saving' || state.phase.requestId !== event.requestId) {
        return state;
      }
      // 下書きは変更せず、そのまま再試行できるようにする
      return {
        ...state,
        phase: { kind: 'editing' },
        lastOutcome: { kind: 'failed', message: event.message },
        rejection: null,
      };
    }

    case 'revertRequested': {
      if (isModalOpen(state)) {
        return reject(state, 'editor', MESSAGES.dialogOpen);
      }
      if (state.phase.kind === 'saving') {
        return reject(state, 'editor', MESSAGES.revertWhileSaving);
      }
      if (!hasUnsavedChanges(state)) {
        return state;
      }
      return {
        ...state,
        draft: findSelected(state).reply,
        lastOutcome: { kind: 'none' },
        rejection: null,
      };
    }

    case 'helpOpened': {
      // 操作説明は保存や編集の前提を変えないため、保存中でも開ける
      if (isModalOpen(state)) {
        return state;
      }
      return { ...state, helpOpen: true, rejection: null };
    }

    case 'helpClosed': {
      return state.helpOpen ? { ...state, helpOpen: false } : state;
    }

    case 'failNextSaveChanged': {
      // 次に受け付ける保存だけに影響するため、保存中も切り替えられる
      return { ...state, failNextSave: event.enabled };
    }
  }
}
