export interface TaskCheckboxProps {
  checked: boolean;
  label: string;
  offset?: number;
  disabled: boolean;
  onToggle: () => void;
}

export function TaskCheckbox({ checked, label, offset, disabled, onToggle }: TaskCheckboxProps) {
  return (
    <input
      type="checkbox"
      className="task-checkbox"
      checked={checked}
      disabled={disabled}
      data-task-offset={offset}
      aria-label={label || "task"}
      onChange={onToggle}
    />
  );
}
