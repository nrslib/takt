import { useCallback, useEffect, useRef, useState } from "react";
import { initialInquiries } from "./data";
import type { Feedback, Inquiry, SaveState } from "./types";

const SAVE_DELAY_MS = 1000;

export function useInquiryEditor() {
  const [inquiries, setInquiries] = useState<Inquiry[]>(initialInquiries);
  const [selectedId, setSelectedId] = useState(initialInquiries[0]?.id ?? "");
  const [draft, setDraft] = useState(initialInquiries[0]?.savedReply ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saveCount, setSaveCount] = useState(0);
  const [failNextSave, setFailNextSave] = useState(false);
  const [pendingSelectionId, setPendingSelectionId] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);

  const selectedInquiry = inquiries.find((inquiry) => inquiry.id === selectedId);
  const hasUnsavedChanges = selectedInquiry ? draft !== selectedInquiry.savedReply : false;

  const notifyBlocked = useCallback((message: string) => {
    setFeedback({ kind: "warning", message });
  }, []);

  const acceptSelection = useCallback(
    (nextId: string) => {
      const nextInquiry = inquiries.find((inquiry) => inquiry.id === nextId);

      if (!nextInquiry) {
        setFeedback({ kind: "error", message: "選択した問い合わせを見つけられませんでした。" });
        return;
      }

      setSelectedId(nextId);
      setDraft(nextInquiry.savedReply);
      setSaveState("idle");
      setFeedback(null);
      setPendingSelectionId(null);
    },
    [inquiries],
  );

  const selectInquiry = useCallback(
    (nextId: string) => {
      if (nextId === selectedId) {
        return;
      }

      if (saveState === "saving" || saveInFlightRef.current) {
        notifyBlocked("保存中のため問い合わせを切り替えられません。保存が完了してからお試しください。");
        return;
      }

      if (pendingSelectionId) {
        notifyBlocked("切り替えの確認中です。先に確認ダイアログで選択してください。");
        return;
      }

      if (hasUnsavedChanges) {
        setPendingSelectionId(nextId);
        setFeedback({
          kind: "warning",
          message: "未保存の変更があります。切り替える前に、変更を破棄するか選択してください。",
        });
        return;
      }

      acceptSelection(nextId);
    },
    [acceptSelection, hasUnsavedChanges, notifyBlocked, pendingSelectionId, saveState, selectedId],
  );

  const updateDraft = useCallback(
    (value: string) => {
      if (saveState === "saving" || saveInFlightRef.current) {
        notifyBlocked("保存中は返信を編集できません。保存が完了するまでお待ちください。");
        return;
      }

      setDraft(value);
      setSaveState("idle");
      setFeedback(null);
    },
    [notifyBlocked, saveState],
  );

  const requestSave = useCallback(() => {
    if (!selectedInquiry) {
      setFeedback({ kind: "error", message: "保存対象の問い合わせがありません。" });
      return;
    }

    if (saveState === "saving" || saveInFlightRef.current) {
      notifyBlocked("保存処理はすでに実行中です。完了するまで追加の保存は受け付けません。");
      return;
    }

    if (pendingSelectionId) {
      notifyBlocked("問い合わせの切り替え確認中は保存できません。先に確認を完了してください。");
      return;
    }

    if (!draft.trim()) {
      setSaveState("idle");
      setFeedback({ kind: "error", message: "返信を入力してください。空白だけの返信は保存できません。" });
      return;
    }

    if (!hasUnsavedChanges) {
      setFeedback({ kind: "info", message: "変更はありません。現在の返信は保存済みです。" });
      return;
    }

    const targetId = selectedInquiry.id;
    const replyToSave = draft;
    const shouldFail = failNextSave;

    saveInFlightRef.current = true;
    setFailNextSave(false);
    setSaveCount((count) => count + 1);
    setSaveState("saving");
    setFeedback({ kind: "info", message: "返信を保存しています。完了まで問い合わせの切り替えはできません。" });

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveInFlightRef.current = false;

      if (shouldFail) {
        setSaveState("error");
        setFeedback({
          kind: "error",
          message: "保存に失敗しました。返信内容は保持しています。もう一度保存してください。",
        });
        return;
      }

      setInquiries((currentInquiries) =>
        currentInquiries.map((inquiry) =>
          inquiry.id === targetId ? { ...inquiry, savedReply: replyToSave } : inquiry,
        ),
      );
      setSaveState("success");
      setFeedback({ kind: "success", message: "返信を保存しました。一覧と詳細に反映されています。" });
    }, SAVE_DELAY_MS);
  }, [draft, failNextSave, hasUnsavedChanges, notifyBlocked, pendingSelectionId, saveState, selectedInquiry]);

  const resetDraft = useCallback(() => {
    if (!selectedInquiry) {
      return;
    }

    if (saveState === "saving" || saveInFlightRef.current) {
      notifyBlocked("保存中は返信を戻せません。保存が完了するまでお待ちください。");
      return;
    }

    if (pendingSelectionId) {
      notifyBlocked("切り替えの確認中は返信を戻せません。先に確認を完了してください。");
      return;
    }

    if (!hasUnsavedChanges) {
      setFeedback({ kind: "info", message: "返信はすでに保存済みの内容です。" });
      return;
    }

    setDraft(selectedInquiry.savedReply);
    setSaveState("idle");
    setFeedback({ kind: "info", message: "保存済みの返信に戻しました。" });
  }, [hasUnsavedChanges, notifyBlocked, pendingSelectionId, saveState, selectedInquiry]);

  const confirmDiscard = useCallback(() => {
    if (!pendingSelectionId) {
      return;
    }

    if (saveState === "saving" || saveInFlightRef.current) {
      notifyBlocked("保存中のため切り替えを確定できません。保存が完了するまでお待ちください。");
      return;
    }

    acceptSelection(pendingSelectionId);
  }, [acceptSelection, notifyBlocked, pendingSelectionId, saveState]);

  const cancelSelection = useCallback(() => {
    setPendingSelectionId(null);
    setFeedback({ kind: "info", message: "問い合わせの切り替えを取り消しました。編集中の内容は保持されています。" });
  }, []);

  const toggleFailNextSave = useCallback(() => {
    setFailNextSave((isEnabled) => !isEnabled);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  return {
    inquiries,
    selectedInquiry,
    selectedId,
    draft,
    saveState,
    feedback,
    saveCount,
    failNextSave,
    pendingSelectionId,
    hasUnsavedChanges,
    updateDraft,
    requestSave,
    resetDraft,
    selectInquiry,
    confirmDiscard,
    cancelSelection,
    toggleFailNextSave,
  };
}
