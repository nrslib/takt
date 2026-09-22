type AppHeaderProps = {
  onOpenHelp: (opener: HTMLElement) => void;
};

export function AppHeader({ onOpenHelp }: AppHeaderProps) {
  return (
    <header className="app-header">
      <h1>問い合わせ返信デスク</h1>
      <button type="button" className="button" onClick={(event) => onOpenHelp(event.currentTarget)}>
        操作説明
      </button>
    </header>
  );
}
