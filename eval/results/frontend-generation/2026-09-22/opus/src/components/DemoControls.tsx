type DemoControlsProps = {
  failNextSave: boolean;
  acceptedSaveCount: number;
  onFailNextSaveChange: (enabled: boolean) => void;
};

export function DemoControls({ failNextSave, acceptedSaveCount, onFailNextSaveChange }: DemoControlsProps) {
  return (
    <aside className="demo-controls" aria-labelledby="demo-controls-heading">
      <h2 id="demo-controls-heading">実演用</h2>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={failNextSave}
          onChange={(event) => onFailNextSaveChange(event.target.checked)}
        />
        次の保存を失敗させる
      </label>
      <p>
        受け付けた保存処理の累計：<output aria-live="polite">{acceptedSaveCount}</output>回
      </p>
    </aside>
  );
}
