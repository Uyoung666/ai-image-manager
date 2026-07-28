interface EmptyStateAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface EmptyStateCardProps {
  actions?: EmptyStateAction[];
  description: string;
  icon: React.ReactNode;
  title: string;
}

/** Shared, compact empty-state layout for the gallery workspace. */
export function EmptyStateCard({
  icon,
  title,
  description,
  actions = [],
}: EmptyStateCardProps) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col items-center gap-4 px-6 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="space-y-1.5">
        <h2 className="font-medium text-[14px] text-foreground">{title}</h2>
        <p className="max-w-[320px] text-[12px] text-muted-foreground leading-relaxed">
          {description}
        </p>
      </div>
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) => (
            <button
              className={`rounded-[6px] px-3 py-1.5 font-medium text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${
                action.primary
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-border bg-card text-foreground hover:bg-foreground/5"
              }`}
              key={action.label}
              onClick={action.onClick}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
